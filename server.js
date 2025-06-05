// server.js - Express.js server for PacketRusher GUI
const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const path = require('path');
const { spawn, exec } = require('child_process');
const yaml = require('js-yaml');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware - Make sure these are in the right order and configured properly
app.use(cors());
app.use(express.json()); // For parsing JSON bodies
app.use(express.urlencoded({ extended: true })); // For parsing URL-encoded bodies
app.use(express.static('public')); // For serving static files if needed

// Add debugging middleware to log all requests
app.use((req, res, next) => {
	console.log(`${req.method} ${req.url}`);
	console.log('Headers:', req.headers);
	console.log('Body:', req.body);
	console.log('Query:', req.query);
	console.log('---');
	next();
});

// Paths to packetrusher folder (sibling folder)
const PACKETRUSHER_DIR = path.join(__dirname, '..', 'PacketRusher');
const CONFIG_PATH = path.join(PACKETRUSHER_DIR, 'config', 'config.yml');
const BINARY_PATH = path.join(PACKETRUSHER_DIR, 'packetrusher');

// Global WebSocket connections
let wsClients = [];

// Key for the server
// key: 00112233445566778899AABBCCDDEEFF
// opc: 00112233445566778899AABBCCDDEEFF

// Server-side state for HTMX
let serverState = {
	currentRunMode: 'scheduled',
	sessionCount: 0,
	totalUeCount: 0,
	baseMsin: null,
	currentMsinBase: null,
	scheduledSessions: [],
	isRunning: false,
	sessionLogs: [],
	packetrusherLogs: [],
};

// Helper function to format time
function formatTime() {
	return new Date().toLocaleTimeString();
}

// Helper function to add log entry
function addLog(message, type = 'session') {
	const logEntry = `[${formatTime()}] ${message}`;
	if (type === 'session') {
		serverState.sessionLogs.unshift(logEntry);
		// Keep only last 100 logs
		if (serverState.sessionLogs.length > 100) {
			serverState.sessionLogs = serverState.sessionLogs.slice(0, 100);
		}
	} else if (type === 'packetrusher') {
		serverState.packetrusherLogs.unshift(logEntry);
		if (serverState.packetrusherLogs.length > 100) {
			serverState.packetrusherLogs = serverState.packetrusherLogs.slice(0, 100);
		}
	}

	// Broadcast log update via WebSocket
	broadcastLogUpdate(logEntry, type);
}

// Helper function to broadcast log updates
function broadcastLogUpdate(message, type = 'session', level = 'info') {
	const time = formatTime();
	let html = '';

	if (type === 'session') {
		html = `<div hx-swap-oob="afterbegin:#logs">[${time}] ${message}<br></div>`;
	} else {
		const color = level === 'error' ? '#ff6b6b' : level === 'warn' ? '#ffa726' : '#e0e0e0';
		html = `<div hx-swap-oob="afterbegin:#packetrusher-logs"><span style="color: ${color}">[${time}] ${message}</span><br></div>`;
	}

	wsClients.forEach((ws) => {
		if (ws.readyState === 1) {
			ws.send(html);
		}
	});
}

// Helper function to update next session display
function updateNextSessionDisplay() {
	if (serverState.currentRunMode === 'runNow') {
		return `<div id="next-session-info" class="status" style="margin-top: 15px; background: #007bff; display: none;"></div>`;
	}

	const now = new Date();
	const upcomingSessions = serverState.scheduledSessions
		.filter((s) => s.scheduledAt.getTime() > now.getTime())
		.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

	if (upcomingSessions.length > 0) {
		const nextSession = upcomingSessions[0];
		const timeToNext = Math.round((nextSession.scheduledAt.getTime() - now.getTime()) / 1000);
		return `<div id="next-session-info" class="status" style="margin-top: 15px; background: #007bff; display: block;">
			Next session: ${nextSession.originalTimeStr} (${nextSession.ueCount} UEs) in ${timeToNext}s
		</div>`;
	} else if (serverState.sessionCount > 0) {
		return `<div id="next-session-info" class="status" style="margin-top: 15px; background: #4CAF50; display: block;">
			All scheduled sessions for today have finished.
		</div>`;
	} else if (serverState.isRunning && serverState.scheduledSessions.length === 0) {
		return `<div id="next-session-info" class="status" style="margin-top: 15px; background: #ff9800; display: block;">
			No future sessions were scheduled (e.g., all flight times past or no data).
		</div>`;
	}

	return `<div id="next-session-info" class="status" style="margin-top: 15px; background: #007bff; display: none;"></div>`;
}

// HTMX Routes

// Internal flight data endpoint (returns JSON for server use)
app.get('/api/flight-data-json', async (req, res) => {
	try {
		const now = new Date();
		const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

		const beginDate = new Date(lastWeek);
		beginDate.setHours(0, 0, 0, 0);

		const endDate = new Date(lastWeek);
		endDate.setHours(23, 59, 59, 999);

		const estimatedPassengers = 174;

		const flightModule = await import('./flight.mjs');
		const arrivalTimestamps = flightModule.flight.map((data) => data.firstSeen || data.lastSeen);
		const today = new Date();

		const arrivalTimes = arrivalTimestamps
			.filter((timestamp) => {
				const date = new Date(timestamp * 1000);
				return date.getDay() === today.getDay();
			})
			.sort((a, b) => a - b)
			.map((timestamp) => {
				const date = new Date(timestamp * 1000);
				const estimatedForeigners = Math.floor(
					estimatedPassengers * 0.4 + Math.random() * (estimatedPassengers * 0.6 - estimatedPassengers * 0.4)
				);

				return {
					time: date.toLocaleTimeString('en-US', { timeZone: 'Asia/Seoul' }),
					foreignPassengers: estimatedForeigners,
				};
			});

		res.json(arrivalTimes);
	} catch (error) {
		console.error('Flight data JSON endpoint error:', error);
		res.status(500).json({ error: error.message, data: [] });
	}
});

// Run Multi-UE Session function (restored)
async function runMultiUeSession(baseIMSI, ueCountForSession, sessionContext = null) {
	return new Promise(async (resolve) => {
		const isScheduledRun = typeof sessionContext === 'string';

		// Update connection status
		const statusHtml = `<div hx-swap-oob="outerHTML:#connection-status">
			<div id="connection-status" class="status running">Session Running...</div>
		</div>`;

		wsClients.forEach((ws) => {
			if (ws.readyState === 1) {
				ws.send(statusHtml);
			}
		});

		if (serverState.baseMsin === null) {
			const msinPart = baseIMSI.slice(-10);
			serverState.baseMsin = parseInt(msinPart);
			serverState.currentMsinBase = serverState.baseMsin;
			addLog(`Warning: baseMsin not initialized by start(), fallback to: ${msinPart}`);
		}

		serverState.sessionCount++;
		const msinDisplay =
			typeof serverState.currentMsinBase === 'number'
				? serverState.currentMsinBase.toString().padStart(10, '0')
				: serverState.currentMsinBase;

		addLog(
			`Session #${serverState.sessionCount} - Starting ${ueCountForSession} UEs (IMSI base: ${baseIMSI.slice(
				0,
				5
			)}${msinDisplay})`
		);

		const startMsin = msinDisplay;
		const endMsinNum =
			typeof serverState.currentMsinBase === 'number' ? serverState.currentMsinBase + ueCountForSession - 1 : 'N/A';
		const endMsin = typeof endMsinNum === 'number' ? endMsinNum.toString().padStart(10, '0') : endMsinNum;

		addLog(` UE Range: MSIN ${startMsin} to ${endMsin} (${ueCountForSession} UEs total for this session)`);

		try {
			const result = await runPacketRusher(serverState.sessionCount, ueCountForSession);

			if (result.success) {
				addLog(`✅ Session #${serverState.sessionCount} completed successfully`);
				serverState.totalUeCount += ueCountForSession;
				if (typeof serverState.currentMsinBase === 'number') {
					serverState.currentMsinBase += ueCountForSession;
				}
			} else {
				addLog(`Session #${serverState.sessionCount} failed: ${result.error}`);
			}
		} catch (e) {
			addLog(`Session #${serverState.sessionCount} error: ${e.message}`);
		} finally {
			if (isScheduledRun) {
				const sessionToMarkDone = serverState.scheduledSessions.find(
					(s) => s.ueCount === ueCountForSession && s.originalTimeStr === sessionContext
				);
				if (sessionToMarkDone) sessionToMarkDone.isRunning = false;
			}

			// Update connection status back to connected
			const connectedStatusHtml = `<div hx-swap-oob="outerHTML:#connection-status">
				<div id="connection-status" class="status connected">Connected to server</div>
			</div>`;

			wsClients.forEach((ws) => {
				if (ws.readyState === 1) {
					ws.send(connectedStatusHtml);
				}
			});

			addLog(`⏱️ Session #${serverState.sessionCount} finished. Total UEs so far: ${serverState.totalUeCount}`);

			if (isScheduledRun) {
				// Update next session display
				const nextSessionHtml = updateNextSessionDisplay();
				const updateHtml = `<div hx-swap-oob="outerHTML:#next-session-info">${nextSessionHtml}</div>`;

				wsClients.forEach((ws) => {
					if (ws.readyState === 1) {
						ws.send(updateHtml);
					}
				});
			} else {
				// For runNow, re-enable start button
				const buttonsHtml = `<div hx-swap-oob="outerHTML:#control-buttons">
					<div id="control-buttons">
						<button class="start"
								hx-post="/api/sessions/start" 
								hx-include="[name='mcc'], [name='mnc'], [name='msinBase'], [name='runMode'], [name='ueCountInput']"
								hx-target="#control-buttons" 
								hx-swap="outerHTML">
							Start Sessions
						</button>
						<button class="stop" disabled
								hx-post="/api/sessions/stop" 
								hx-target="#control-buttons" 
								hx-swap="outerHTML">
							Stop / Reset
						</button>
						<button class="clear" 
								hx-post="/api/logs/clear" 
								hx-target="#logs-container"
								hx-swap="innerHTML">
							Clear Logs
						</button>
						<button class="get-flight-data" 
								hx-get="/api/flight-data" 
								hx-target="#flight-data-display">
							Get Flight Data
						</button>
					</div>
				</div>`;

				wsClients.forEach((ws) => {
					if (ws.readyState === 1) {
						ws.send(buttonsHtml);
					}
				});

				serverState.isRunning = false;
			}

			resolve();
		}
	});
}

// Mode change handler
app.post('/api/ui/mode-change', (req, res) => {
	console.log('Mode change request body:', req.body);

	const { runMode } = req.body;
	serverState.currentRunMode = runMode || 'scheduled';

	let html = '';
	if (runMode === 'scheduled') {
		html = `
			<div id="mode-dependent-ui">
				<div class="input-group" style="margin-top: 10px;">
					<input type="number" name="ueCountInput" placeholder="Number of UEs (for Run Now)" 
						   value="1" min="1" max="100" disabled>
				</div>
				<small style="color: #888; font-size: 11px; display: block;">
					UE count for "Run Now" mode. For "Scheduled", it's from flight data.
				</small>
			</div>
		`;
	} else {
		html = `
			<div id="mode-dependent-ui">
        <div class="input-group" style="margin-top: 10px;">
					<input type="number" name="ueCountInput" placeholder="Number of UEs (for Run Now)" 
						   value="1" min="1" max="100">
				</div>
				<small style="color: #888; font-size: 11px; display: block;">
					Enter the number of UEs for the immediate session.
				</small>
			</div>
		`;
	}

	// Also update next session display
	const nextSessionHtml = updateNextSessionDisplay();
	html += `<div hx-swap-oob="outerHTML:#next-session-info">${nextSessionHtml}</div>`;

	res.send(html);
});

// Start sessions handler - FIXED VERSION
app.post('/api/sessions/start', async (req, res) => {
	console.log('=== START SESSION REQUEST ===');
	console.log('Request body:', req.body);
	console.log('Request content-type:', req.headers['content-type']);
	console.log('Request method:', req.method);

	// Handle both URL-encoded and JSON data
	let formData = req.body;

	// If req.body is empty, try to parse from raw body (fallback)
	if (!formData || Object.keys(formData).length === 0) {
		console.log('Request body is empty, checking if data was sent...');
		return res.status(400).send(`
			<div class="status" style="background: #d32f2f; margin: 10px 0;">
				No form data received. Please ensure all form fields are filled out.
			</div>
		`);
	}

	// Extract data with fallbacks
	const mcc = formData.mcc || '';
	const mnc = formData.mnc || '';
	const msinBase = formData.msinBase || '';
	const runMode = formData.runMode || 'scheduled';
	const ueCountInput = formData.ueCountInput || '1';

	console.log('Extracted values:', { mcc, mnc, msinBase, runMode, ueCountInput });

	// Validation
	if (!mcc || mcc.length !== 3) {
		console.log('MCC validation failed:', mcc);
		return res.status(400).send(`
			<div class="status" style="background: #d32f2f; margin: 10px 0;">
				Enter a valid 3-character MCC. Current value: "${mcc}"
			</div>
		`);
	}

	if (!mnc || mnc.length !== 2) {
		console.log('MNC validation failed:', mnc);
		return res.status(400).send(`
			<div class="status" style="background: #d32f2f; margin: 10px 0;">
				Enter a valid 2-character MNC. Current value: "${mnc}"
			</div>
		`);
	}

	if (!msinBase || msinBase.length !== 10) {
		console.log('MSIN validation failed:', msinBase);
		return res.status(400).send(`
			<div class="status" style="background: #d32f2f; margin: 10px 0;">
				Enter a valid 10-character Base MSIN. Current value: "${msinBase}"
			</div>
		`);
	}

	// Update server state
	serverState.currentRunMode = runMode;
	serverState.isRunning = true;
	serverState.sessionCount = 0;
	serverState.totalUeCount = 0;

	const baseIMSI = mcc + mnc + msinBase;
	console.log('Generated base IMSI:', baseIMSI);

	try {
		serverState.baseMsin = parseInt(msinBase);
		if (isNaN(serverState.baseMsin)) {
			addLog('Warning: Base MSIN is not a number. IMSI incrementation might behave unexpectedly.');
			serverState.currentMsinBase = msinBase;
		} else {
			serverState.currentMsinBase = serverState.baseMsin;
		}
	} catch (e) {
		addLog('Error parsing MSIN: ' + e.message + '. Proceeding with MSIN as string.');
		serverState.currentMsinBase = msinBase;
	}

	if (runMode === 'scheduled') {
		addLog(
			`Fetching flight data to schedule PacketRusher sessions with base IMSI prefix: ${mcc}${mnc} and MSIN starting from ${msinBase}`
		);

		// Clear existing sessions
		serverState.scheduledSessions.forEach((session) => clearTimeout(session.id));
		serverState.scheduledSessions = [];

		try {
			// Fetch flight data (reuse existing endpoint logic)
			const flightResponse = await fetch(`http://localhost:${PORT}/api/flight-data-json`);
			const flightData = await flightResponse.json();

			if (!flightData || flightData.length === 0) {
				addLog('No flight data available or error fetching. Cannot schedule sessions.');
				const nextSessionHtml = updateNextSessionDisplay();

				return res.send(`
					<div id="control-buttons">
						<button class="start" 
								hx-post="/api/sessions/start" 
								hx-include="[name='mcc'], [name='mnc'], [name='msinBase'], [name='runMode'], [name='ueCountInput']"
								hx-target="#control-buttons" 
								hx-swap="outerHTML">
							Start Sessions
						</button>
						<button class="stop" disabled
								hx-post="/api/sessions/stop" 
								hx-target="#control-buttons" 
								hx-swap="outerHTML">
							Stop / Reset
						</button>
						<button class="clear" 
								hx-post="/api/logs/clear" 
								hx-target="#logs-container"
								hx-swap="innerHTML">
							Clear Logs
						</button>
						<button class="get-flight-data" 
								hx-get="/api/flight-data" 
								hx-target="#flight-data-display">
							Get Flight Data
						</button>
					</div>
					<div hx-swap-oob="outerHTML:#next-session-info">${nextSessionHtml}</div>
				`);
			}

			addLog(`Found ${flightData.length} flight entries. Scheduling sessions...`);

			const now = new Date();
			let scheduledCount = 0;

			flightData.forEach((flight, index) => {
				const [timeStr, period] = flight.time.split(' ');
				let [hours, minutes, seconds] = timeStr.split(':').map(Number);

				if (period === 'PM' && hours !== 12) {
					hours += 12;
				} else if (period === 'AM' && hours === 12) {
					hours = 0;
				}

				const flightTimeToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds);
				const delay = flightTimeToday.getTime() - now.getTime();

				if (delay > 0) {
					const timeoutId = setTimeout(async () => {
						// Update next session display to show running
						const runningHtml = `<div hx-swap-oob="outerHTML:#next-session-info">
							<div id="next-session-info" class="status" style="margin-top: 15px; background: #f57c00; display: block;">
								Running session for: ${flight.time} (${flight.foreignPassengers} UEs)
							</div>
						</div>`;

						wsClients.forEach((ws) => {
							if (ws.readyState === 1) {
								ws.send(runningHtml);
							}
						});

						// Run the actual session
						await runMultiUeSession(baseIMSI, flight.foreignPassengers, flight.time);
					}, delay);

					serverState.scheduledSessions.push({
						id: timeoutId,
						scheduledAt: flightTimeToday,
						originalTimeStr: flight.time,
						ueCount: flight.foreignPassengers,
						isRunning: false,
					});
					scheduledCount++;
				} else {
					addLog(`Skipping past flight time: ${flight.time}`);
				}
			});

			if (scheduledCount > 0) {
				addLog(`Successfully scheduled ${scheduledCount} future sessions based on flight data.`);
				const msinDisplay =
					typeof serverState.currentMsinBase === 'number'
						? serverState.currentMsinBase.toString().padStart(10, '0')
						: serverState.currentMsinBase;
				addLog(
					`Base MSIN for the first session will be ${msinDisplay}. It will increment for subsequent UEs/sessions.`
				);
			} else {
				addLog('No future flight times found to schedule. All flight times may be in the past for today.');
			}
		} catch (error) {
			addLog(`Error scheduling sessions: ${error.message}`);
		}
	} else {
		// runNow
		const ueCount = parseInt(ueCountInput);
		if (isNaN(ueCount) || ueCount < 1) {
			return res.status(400).send(`
				<div class="status" style="background: #d32f2f; margin: 10px 0;">
					Please enter a valid number of UEs for Run Now mode (1 or more). Current value: "${ueCountInput}"
				</div>
			`);
		}

		const msinDisplay =
			typeof serverState.currentMsinBase === 'number'
				? serverState.currentMsinBase.toString().padStart(10, '0')
				: serverState.currentMsinBase;
		addLog(`Starting a single session with ${ueCount} UEs now. Base MSIN: ${msinDisplay}`);

		// Run immediately
		setTimeout(async () => {
			await runMultiUeSession(baseIMSI, ueCount, { type: 'runNow' });
		}, 100);
	}

	const nextSessionHtml = updateNextSessionDisplay();

	// Return updated button state
	res.send(`
		<div id="control-buttons">
			<button class="start" disabled
					hx-post="/api/sessions/start" 
					hx-include="[name='mcc'], [name='mnc'], [name='msinBase'], [name='runMode'], [name='ueCountInput']"
					hx-target="#control-buttons" 
					hx-swap="outerHTML">
				Start Sessions
			</button>
			<button class="stop"
					hx-post="/api/sessions/stop" 
					hx-target="#control-buttons" 
					hx-swap="outerHTML">
				Stop / Reset
			</button>
			<button class="clear" 
					hx-post="/api/logs/clear" 
					hx-target="#logs-container"
					hx-swap="innerHTML">
				Clear Logs
			</button>
			<button class="get-flight-data" 
					hx-get="/api/flight-data" 
					hx-target="#flight-data-display">
				Get Flight Data
			</button>
		</div>
		<div hx-swap-oob="outerHTML:#next-session-info">${nextSessionHtml}</div>
	`);
});

// Stop sessions handler
app.post('/api/sessions/stop', (req, res) => {
	// Clear scheduled sessions
	serverState.scheduledSessions.forEach((session) => clearTimeout(session.id));
	serverState.scheduledSessions = [];
	serverState.isRunning = false;

	addLog(
		`Stopped / Reset. ${serverState.sessionCount} sessions ran in the last active period, ${serverState.totalUeCount} total UEs processed.`
	);

	// Reset some state
	serverState.baseMsin = null;
	serverState.currentMsinBase = null;

	const nextSessionHtml = updateNextSessionDisplay();

	res.send(`
		<div id="control-buttons">
			<button class="start"
					hx-post="/api/sessions/start" 
					hx-include="[name='mcc'], [name='mnc'], [name='msinBase'], [name='runMode'], [name='ueCountInput']"
					hx-target="#control-buttons" 
					hx-swap="outerHTML">
				Start Sessions
			</button>
			<button class="stop" disabled
					hx-post="/api/sessions/stop" 
					hx-target="#control-buttons" 
					hx-swap="outerHTML">
				Stop / Reset
			</button>
			<button class="clear" 
					hx-post="/api/logs/clear" 
					hx-target="#logs-container"
					hx-swap="innerHTML">
				Clear Logs
			</button>
			<button class="get-flight-data" 
					hx-get="/api/flight-data" 
					hx-target="#flight-data-display">
				Get Flight Data
			</button>
        </div>
		<div hx-swap-oob="outerHTML:#next-session-info">${nextSessionHtml}</div>
	`);
});

// Clear logs handler
app.post('/api/logs/clear', (req, res) => {
	serverState.sessionLogs = [];
	serverState.packetrusherLogs = [];

	res.send(`
            <div class="log-section">
                <h3>Session Logs</h3>
                <div id="logs"></div>
            </div>
            <div class="log-section">
                <h3>PacketRusher Output</h3>
                <div id="packetrusher-logs"></div>
            </div>
	`);
});

// Updated flight data endpoint to return HTML for display
app.get('/api/flight-data', async (req, res) => {
	try {
		const { airport = 'RKSI', accessToken } = req.query;

		// Calculate timestamps for last week same day (full 24 hours)
		const now = new Date();
		const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

		// Set to beginning of that day (00:00:00)
		const beginDate = new Date(lastWeek);
		beginDate.setHours(0, 0, 0, 0);

		// Set to end of that day (23:59:59)
		const endDate = new Date(lastWeek);
		endDate.setHours(23, 59, 59, 999);

		const beginTimestamp = Math.floor(beginDate.getTime() / 1000);
		const endTimestamp = Math.floor(endDate.getTime() / 1000);

		const estimatedPassengers = 174; // Passengers per arrival

		console.log('Fetching flight data from OpenSky Network...');
		console.log('Begin timestamp:', beginTimestamp);
		console.log('End timestamp:', endTimestamp);

		// Use dynamic import for ES module (server-side only)
		const flightModule = await import('./flight.mjs');

		const arrivalTimestamps = flightModule.flight.map((data) => data.firstSeen || data.lastSeen);
		const today = new Date();

		// From the timestamps, I should be able to get the time value, HH:MM:SS in KST timezone
		const arrivalTimes = arrivalTimestamps
			.filter((timestamp) => {
				const date = new Date(timestamp * 1000);
				return date.getDay() === today.getDay();
			})
			.sort((a, b) => a - b)
			.map((timestamp) => {
				const date = new Date(timestamp * 1000);
				// Estimated foreigners are 40% - 60% of total passengers, it should be random
				const estimatedForeigners = Math.floor(
					estimatedPassengers * 0.4 + Math.random() * (estimatedPassengers * 0.6 - estimatedPassengers * 0.4)
				);

				const data = {
					time: date.toLocaleTimeString('en-US', { timeZone: 'Asia/Seoul' }),
					foreignPassengers: estimatedForeigners,
				};

				return data;
			});

		console.log(today.getDay());
		console.log(arrivalTimes);

		// Return HTML for display
		let html = '<div class="status" style="background: #2196F3; margin: 10px 0;">Flight Data Retrieved</div>';
		html +=
			'<div style="background: #2a2a2a; padding: 15px; border-radius: 5px; margin: 10px 0; font-family: monospace; font-size: 12px;">';
		html += '<h4 style="color: #4CAF50; margin: 0 0 10px 0;">Flight Arrivals for Today:</h4>';

		if (arrivalTimes.length > 0) {
			arrivalTimes.forEach((flight) => {
				html += `<div style="margin: 5px 0; color: #e0e0e0;">${flight.time} - ${flight.foreignPassengers} foreign passengers</div>`;
			});
		} else {
			html += '<div style="color: #ff9800;">No flight data available for today</div>';
		}

		html += '</div>';

		res.send(html);
	} catch (error) {
		console.error('Flight data endpoint error:', error);
		res.send(`
			<div class="status" style="background: #d32f2f; margin: 10px 0;">
				Error fetching flight data: ${error.message}
			</div>
		`);
	}
});

// Express Routes

// Serve the main HTML page
app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, 'index.html'));
});

// WebSocket route for HTMX
app.get('/ws', (req, res) => {
	// This route is for HTMX WebSocket extension to connect to
	res.status(200).send('WebSocket endpoint');
});

// Health check endpoint
app.get('/health', (req, res) => {
	res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
const server = app.listen(PORT, async () => {
	console.log(`Server running at http://localhost:${PORT}`);
	console.log(`PacketRusher directory: ${PACKETRUSHER_DIR}`);

	// Check if packetrusher binary exists
	try {
		await fs.access(BINARY_PATH);
		console.log(`\n✓ PacketRusher binary found: ${BINARY_PATH}`);
		// Check if it's executable
		try {
			await fs.access(BINARY_PATH, fsConstants.X_OK);
			console.log('✓ Binary is executable');
		} catch (err) {
			console.log('⚠ Binary may not be executable. Run: chmod +x ../PacketRusher/packetrusher');
		}
	} catch (err) {
		console.error(`\n✗ PacketRusher binary NOT found at: ${BINARY_PATH}`);
		console.error('Please ensure PacketRusher is built and located in the correct directory');
	}

	// Check if config.yml exists
	try {
		await fs.access(CONFIG_PATH);
		console.log(`✓ Config file found: ${CONFIG_PATH}`);
	} catch (err) {
		console.error(`✗ Config file NOT found at: ${CONFIG_PATH}`);
		console.error('Please ensure config.yml exists in the PacketRusher config directory');
	}

	console.log('\n📱 Open http://localhost:3000 in your browser to start using the controller');
});

// WebSocket Server for HTMX
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
	console.log('New HTMX WebSocket client connected');
	wsClients.push(ws);

	// Send welcome message as HTML
	ws.send(`<div hx-swap-oob="afterbegin:#logs">[${formatTime()}] 🔗 Connected to PacketRusher Controller<br></div>`);

	ws.on('close', () => {
		console.log('HTMX WebSocket client disconnected');
		wsClients = wsClients.filter((client) => client !== ws);
	});

	ws.on('error', (error) => {
		console.error('HTMX WebSocket error:', error);
		wsClients = wsClients.filter((client) => client !== ws);
	});
});

// Run PacketRusher directly in the app
function runPacketRusher(sessionNumber = 1, ueCount = 1) {
	return new Promise(async (resolve) => {
		console.log(`\nSession #${sessionNumber}: Starting PacketRusher multi-ue with ${ueCount} UEs`);

		// Update config for PacketRusher
		try {
			await fs.access(CONFIG_PATH);
			const configContent = await fs.readFile(CONFIG_PATH, 'utf8');
			const config = yaml.load(configContent);

			if (!config.ue) {
				resolve({
					success: false,
					error: 'Invalid config.yml structure - missing "ue" section',
				});
				return;
			}

			// Set the base MSIN - PacketRusher will increment from this base for each UE
			const msinDisplay =
				typeof serverState.currentMsinBase === 'number'
					? serverState.currentMsinBase.toString().padStart(10, '0')
					: serverState.currentMsinBase;
			config.ue.msin = msinDisplay;

			// Write config back
			await fs.writeFile(CONFIG_PATH, yaml.dump(config), 'utf8');
		} catch (err) {
			resolve({
				success: false,
				error: `Config error: ${err.message}`,
			});
			return;
		}

		// Broadcast to all WebSocket clients
		const broadcast = (message, level = 'info') => {
			broadcastLogUpdate(message, 'packetrusher', level);
		};

		broadcast(`🚀 Session #${sessionNumber} starting with ${ueCount} UEs...`);

		const process = spawn('./packetrusher', ['multi-ue', '-n', ueCount.toString()], {
			cwd: PACKETRUSHER_DIR,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let output = '';
		let errorOutput = '';
		let processKilled = false;

		// Kill process after 30 seconds (increased timeout for multi-UE)
		const killTimer = setTimeout(() => {
			if (!processKilled) {
				processKilled = true;
				process.kill('SIGTERM');
				broadcast(`✅ Session #${sessionNumber} completed on kill timer`, 'info');
				console.log(`Session #${sessionNumber} PacketRusher process terminated after 30 seconds`);
			}
		}, 30000);

		process.stdout.on('data', (data) => {
			const text = data.toString().trim();
			if (text) {
				output += text + '\n';
				// Split by lines and broadcast each line
				text.split('\n').forEach((line) => {
					if (line.trim()) {
						broadcast(line.trim());
						console.log(`[Session #${sessionNumber} Output]:`, line.trim());
					}
				});
			}
		});

		process.stderr.on('data', (data) => {
			const text = data.toString().trim();
			if (text) {
				errorOutput += text + '\n';
				// Split by lines and broadcast each line as error
				text.split('\n').forEach((line) => {
					if (line.trim()) {
						broadcast(line.trim(), 'error');
						console.error(`[Session #${sessionNumber} Error]:`, line.trim());
					}
				});
			}
		});

		process.on('close', (code) => {
			clearTimeout(killTimer);
			const duration = processKilled
				? '30s (timeout)'
				: `${Math.round((Date.now() - process.spawnargs.startTime) / 1000)}s`;

			if (code === 0) {
				broadcast(`✅ Session #${sessionNumber} completed successfully (exit code: ${code})`, 'info');
				console.log(`Session #${sessionNumber} PacketRusher completed successfully`);
				resolve({
					success: true,
					output: `Session #${sessionNumber} completed successfully (${ueCount} UEs)`,
					error: '',
					duration: duration,
				});
			} else {
				broadcast(`✅ Session #${sessionNumber} completed`, 'info');
				console.log(`Session #${sessionNumber} PacketRusher exited with code ${code}`);
				resolve({
					success: false,
					output: output,
					error: errorOutput || `Process exited with code ${code}`,
					duration: duration,
				});
			}
		});

		process.on('error', (err) => {
			clearTimeout(killTimer);
			broadcast(`💥 Session #${sessionNumber} failed to start: ${err.message}`, 'error');
			console.error(`Failed to start Session #${sessionNumber} PacketRusher:`, err);
			resolve({
				success: false,
				error: `Failed to start PacketRusher: ${err.message}`,
				output: '',
				duration: '0s',
			});
		});

		// Store start time for duration calculation
		process.spawnargs.startTime = Date.now();
	});
}