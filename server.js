// server.js - Simplified Express.js server for PacketRusher GUI
const fs = require("fs").promises;
const fsConstants = require("fs").constants;
const path = require("path");
const { spawn } = require("child_process");
const yaml = require("js-yaml");
const WebSocket = require("ws");
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// Add debugging middleware to log all requests
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  console.log("Query:", req.query);
  console.log("---");
  next();
});

// Paths to packetrusher folder (sibling folder)
const PACKETRUSHER_DIR = path.join(__dirname, "..", "PacketRusher");
const CONFIG_PATH = path.join(PACKETRUSHER_DIR, "config", "config.yml");
const BINARY_PATH = path.join(PACKETRUSHER_DIR, "packetrusher");

// Global WebSocket connections
let wsClients = [];

// Server-side state
let serverState = {
  isRunning: false,
  currentUeIndex: 0,
  totalUeCount: 0,
  currentMsin: null,
  mcc: null,
  mnc: null,
  plmnmcc: null,
  plmnmnc: null,
  amfIP: null,
  amfPort: null,
  sessionLogs: [],
  packetrusherLogs: [],
  sessionAborted: false,
};

// Helper function to format time
function formatTime() {
  return new Date().toLocaleTimeString();
}

// Helper function to add log entry
function addLog(message, type = "session") {
  const logEntry = `[${formatTime()}] ${message}`;
  if (type === "session") {
    serverState.sessionLogs.unshift(logEntry);
    if (serverState.sessionLogs.length > 100) {
      serverState.sessionLogs = serverState.sessionLogs.slice(0, 100);
    }
  } else if (type === "packetrusher") {
    serverState.packetrusherLogs.unshift(logEntry);
    if (serverState.packetrusherLogs.length > 100) {
      serverState.packetrusherLogs = serverState.packetrusherLogs.slice(0, 100);
    }
  }

  // Broadcast log update via WebSocket
  broadcastLogUpdate(logEntry, type);
}

// Helper function to broadcast log updates
function broadcastLogUpdate(message, type = "session", level = "info") {
  const time = formatTime();
  let html = "";

  if (type === "session") {
    html = `<div hx-swap-oob="afterbegin:#logs">[${time}] ${message}<br></div>`;
  } else {
    const color =
      level === "error" ? "#ff6b6b" : level === "warn" ? "#ffa726" : "#e0e0e0";
    html = `<div hx-swap-oob="afterbegin:#packetrusher-logs"><span style="color: ${color}">[${time}] ${message}</span><br></div>`;
  }

  wsClients.forEach((ws) => {
    if (ws.readyState === 1) {
      ws.send(html);
    }
  });
}

// Helper function to update progress display
function updateProgressDisplay() {
  const progress =
    serverState.totalUeCount > 0
      ? `${serverState.currentUeIndex}/${serverState.totalUeCount}`
      : "0/0";

  const currentMsinDisplay = serverState.currentMsin
    ? serverState.currentMsin.toString().padStart(10, "0")
    : "N/A";

  const html = `<div hx-swap-oob="outerHTML:#progress-info">
		<div id="progress-info" class="status" style="margin-top: 15px; background: ${
      serverState.isRunning ? "#007bff" : "#4CAF50"
    };">
			Progress: ${progress} | Current MSIN: ${currentMsinDisplay}
		</div>
	</div>`;

  wsClients.forEach((ws) => {
    if (ws.readyState === 1) {
      ws.send(html);
    }
  });
}

// Function to update config with new MSIN and PLMN/AMF settings
async function updateConfig(msin, plmnmcc, plmnmnc, amfIP, amfPort) {
  try {
    const configContent = await fs.readFile(CONFIG_PATH, "utf8");
    const config = yaml.load(configContent);

    if (!config.ue) {
      throw new Error('Invalid config.yml structure - missing "ue" section');
    }

    // Update MSIN in config
    config.ue.msin = msin.toString().padStart(10, "0");

    // Update PLMN configuration if provided
    if (plmnmcc && plmnmnc) {
      if (!config.gnodeb) config.gnodeb = {};
      if (!config.gnodeb.plmnlist) config.gnodeb.plmnlist = {};
      config.gnodeb.plmnlist.mcc = plmnmcc;
      config.gnodeb.plmnlist.mnc = plmnmnc;
    }

    // Update AMF configuration if provided
    if (amfIP && amfPort) {
      if (!Array.isArray(config.amfif)) {
        config.amfif = [{ ip: amfIP, port: parseInt(amfPort) }];
      } else {
        config.amfif[0] = {
          ip: amfIP,
          port: parseInt(amfPort),
        };
      }
    }

    // Write config back
    await fs.writeFile(CONFIG_PATH, yaml.dump(config), "utf8");
    return true;
  } catch (err) {
    addLog(`Config update error: ${err.message}`);
    return false;
  }
}

// Function to run a single UE
function runSingleUE(ueIndex) {
  return new Promise((resolve) => {
    addLog(
      `Starting UE #${ueIndex} with MSIN: ${serverState.currentMsin
        .toString()
        .padStart(10, "0")}`
    );

    const broadcast = (message, level = "info") => {
      broadcastLogUpdate(message, "packetrusher", level);
    };

    broadcast(
      `🚀 UE #${ueIndex} starting with MSIN ${serverState.currentMsin
        .toString()
        .padStart(10, "0")}...`
    );

    const process = spawn("./packetrusher", ["ue"], {
      cwd: PACKETRUSHER_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let errorOutput = "";
    let processKilled = false;

    // Kill process after 10 seconds if it doesn't terminate
    const killTimer = setTimeout(() => {
      if (!processKilled) {
        processKilled = true;
        process.kill("SIGTERM");
        broadcast(`✅ UE #${ueIndex} completed (timeout)`, "info");
        console.log(
          `UE #${ueIndex} PacketRusher process terminated after 3 seconds`
        );
      }
    }, 3000);

    process.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text) {
        output += text + "\n";
        text.split("\n").forEach((line) => {
          if (line.trim()) {
            broadcast(line.trim());
            console.log(`[UE #${ueIndex} Output]:`, line.trim());
          }
        });
      }
    });

    process.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) {
        errorOutput += text + "\n";
        text.split("\n").forEach((line) => {
          if (line.trim()) {
            broadcast(line.trim(), "error");
            console.error(`[UE #${ueIndex} Error]:`, line.trim());
          }
        });
      }
    });

    process.on("close", (code) => {
      clearTimeout(killTimer);

      broadcast(`✅ UE #${ueIndex} completed (exit code: ${code})`, "info");
      console.log(`UE #${ueIndex} PacketRusher exited with code ${code}`);

      resolve({
        success: true,
        output: output,
        error: errorOutput,
      });
    });

    process.on("error", (err) => {
      clearTimeout(killTimer);
      broadcast(`💥 UE #${ueIndex} failed to start: ${err.message}`, "error");
      console.error(`Failed to start UE #${ueIndex} PacketRusher:`, err);
      resolve({
        success: false,
        error: `Failed to start PacketRusher: ${err.message}`,
        output: "",
      });
    });
  });
}

// Function to run UEs sequentially
async function runSequentialUEs() {
  for (let i = 1; i <= serverState.totalUeCount; i++) {
    if (serverState.sessionAborted) {
      addLog("Session aborted by user");
      break;
    }

    serverState.currentUeIndex = i;
    updateProgressDisplay();

    // Update config with current MSIN and other parameters
    const configUpdated = await updateConfig(
      serverState.currentMsin,
      serverState.plmnmcc,
      serverState.plmnmnc,
      serverState.amfIP,
      serverState.amfPort
    );
    if (!configUpdated) {
      addLog(`Failed to update config for UE #${i}, stopping session`);
      break;
    }

    // Run the UE
    const result = await runSingleUE(i);

    if (result.success) {
      addLog(`✅ UE #${i} completed successfully`);
    } else {
      addLog(`❌ UE #${i} failed: ${result.error}`);
    }

    // Increment MSIN for next UE
    serverState.currentMsin++;
  }

  // Session completed
  serverState.isRunning = false;
  updateProgressDisplay();

  if (serverState.sessionAborted) {
    addLog(
      `🛑 Session aborted. Completed ${serverState.currentUeIndex - 1}/${
        serverState.totalUeCount
      } UEs`
    );
  } else {
    addLog(
      `🎉 All UEs completed! Total: ${serverState.totalUeCount} UEs processed`
    );
  }

  // Re-enable start button
  const buttonsHtml = `<div hx-swap-oob="outerHTML:#control-buttons">
		<div id="control-buttons">
			<button class="start"
					hx-post="/api/sessions/start" 
					hx-include="[name='mcc'], [name='mnc'], [name='msinBase'], [name='ueCount'], [name='plmnmcc'], [name='plmnmnc'], [name='amfIP'], [name='amfPort']"
					hx-target="#control-buttons" 
					hx-swap="outerHTML">
				Start UE Sessions
			</button>
			<button class="stop" disabled
					hx-post="/api/sessions/stop" 
					hx-target="#control-buttons" 
					hx-swap="outerHTML">
				Stop Sessions
			</button>
			<button class="clear" 
					hx-post="/api/logs/clear" 
					hx-target="#logs-container"
					hx-swap="innerHTML">
				Clear Logs
			</button>
		</div>
	</div>`;

  wsClients.forEach((ws) => {
    if (ws.readyState === 1) {
      ws.send(buttonsHtml);
    }
  });
}

// Validation functions
function validateIP(ip) {
  const ipRegex =
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipRegex.test(ip);
}

// Start sessions handler
app.post("/api/sessions/start", async (req, res) => {
  console.log("=== START SESSION REQUEST ===");
  console.log("Request body:", req.body);

  const formData = req.body;

  if (!formData || Object.keys(formData).length === 0) {
    return res.status(400).send(`
			<div class="status" style="background: #d32f2f; margin: 10px 0;">
				No form data received. Please ensure all form fields are filled out.
			</div>
		`);
  }

  // Extract all form values
  const mcc = formData.mcc || "";
  const mnc = formData.mnc || "";
  const msinBase = formData.msinBase || "";
  const ueCount = parseInt(formData.ueCount) || 1;
  const plmnmcc = formData.plmnmcc || "";
  const plmnmnc = formData.plmnmnc || "";
  const amfIP = formData.amfIP || "";
  const amfPort = formData.amfPort || "";

  console.log("Extracted values:", {
    mcc,
    mnc,
    msinBase,
    ueCount,
    plmnmcc,
    plmnmnc,
    amfIP,
    amfPort,
  });

  // Comprehensive validation
  const validationErrors = [];

  // UE validation
  if (!mcc || mcc.length !== 3) {
    validationErrors.push(`MCC must be 3 digits. Current: "${mcc}"`);
  }
  if (!mnc || mnc.length !== 2) {
    validationErrors.push(`MNC must be 2 digits. Current: "${mnc}"`);
  }
  if (!msinBase || msinBase.length !== 10) {
    validationErrors.push(
      `MSIN Base must be 10 digits. Current: "${msinBase}"`
    );
  }
  if (ueCount < 1 || ueCount > 100000) {
    validationErrors.push(
      `UE Count must be between 1 and 100000. Current: "${ueCount}"`
    );
  }

  // PLMN validation
  if (plmnmcc && plmnmcc.length !== 3) {
    validationErrors.push(`PLMN MCC must be 3 digits. Current: "${plmnmcc}"`);
  }
  if (plmnmnc && plmnmnc.length !== 2) {
    validationErrors.push(`PLMN MNC must be 2 digits. Current: "${plmnmnc}"`);
  }

  // AMF validation
  if (amfIP && !validateIP(amfIP)) {
    validationErrors.push(
      `AMF IP must be a valid IP address. Current: "${amfIP}"`
    );
  }
  if (amfPort && (isNaN(amfPort) || amfPort < 1 || amfPort > 65535)) {
    validationErrors.push(
      `AMF Port must be between 1-65535. Current: "${amfPort}"`
    );
  }

  if (validationErrors.length > 0) {
    return res.status(400).send(`
			<div class="status" style="background: #d32f2f; margin: 10px 0;">
				Validation errors:<br>• ${validationErrors.join("<br>• ")}
			</div>
		`);
  }

  // Update server state
  serverState.isRunning = true;
  serverState.currentUeIndex = 0;
  serverState.totalUeCount = ueCount;
  serverState.currentMsin = parseInt(msinBase);
  serverState.mcc = mcc;
  serverState.mnc = mnc;
  serverState.plmnmcc = plmnmcc;
  serverState.plmnmnc = plmnmnc;
  serverState.amfIP = amfIP;
  serverState.amfPort = amfPort;
  serverState.sessionAborted = false;

  const baseIMSI = mcc + mnc + msinBase;
  addLog(`🚀 Starting sequential UE sessions`);
  addLog(`Base IMSI: ${baseIMSI}`);
  addLog(`Starting MSIN: ${msinBase}`);
  if (plmnmcc && plmnmnc) {
    addLog(`PLMN: ${plmnmcc}/${plmnmnc}`);
  }
  if (amfIP && amfPort) {
    addLog(`AMF: ${amfIP}:${amfPort}`);
  }
  addLog(`Total UEs to process: ${ueCount}`);

  // Start sequential UE processing in background
  setTimeout(() => {
    runSequentialUEs();
  }, 100);

  updateProgressDisplay();

  // Return updated button state
  res.send(`
		<div id="control-buttons">
			<button class="start" disabled
					hx-post="/api/sessions/start" 
					hx-include="[name='mcc'], [name='mnc'], [name='msinBase'], [name='ueCount'], [name='plmnmcc'], [name='plmnmnc'], [name='amfIP'], [name='amfPort']"
					hx-target="#control-buttons" 
					hx-swap="outerHTML">
				Start UE Sessions
			</button>
			<button class="stop"
					hx-post="/api/sessions/stop" 
					hx-target="#control-buttons" 
					hx-swap="outerHTML">
				Stop Sessions
			</button>
			<button class="clear" 
					hx-post="/api/logs/clear" 
					hx-target="#logs-container"
					hx-swap="innerHTML">
				Clear Logs
			</button>
		</div>
	`);
});

// Stop sessions handler
app.post("/api/sessions/stop", (req, res) => {
  serverState.sessionAborted = true;
  serverState.isRunning = false;

  addLog(`🛑 Stop requested. Current session will be aborted.`);

  updateProgressDisplay();

  res.send(`
		<div id="control-buttons">
			<button class="start"
					hx-post="/api/sessions/start" 
					hx-include="[name='mcc'], [name='mnc'], [name='msinBase'], [name='ueCount'], [name='plmnmcc'], [name='plmnmnc'], [name='amfIP'], [name='amfPort']"
					hx-target="#control-buttons" 
					hx-swap="outerHTML">
				Start UE Sessions
			</button>
			<button class="stop" disabled
					hx-post="/api/sessions/stop" 
					hx-target="#control-buttons" 
					hx-swap="outerHTML">
				Stop Sessions
			</button>
			<button class="clear" 
					hx-post="/api/logs/clear" 
					hx-target="#logs-container"
					hx-swap="innerHTML">
				Clear Logs
			</button>
		</div>
	`);
});

// Clear logs handler
app.post("/api/logs/clear", (req, res) => {
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

// Serve the main HTML page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Start server
const server = app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`PacketRusher directory: ${PACKETRUSHER_DIR}`);

  // Check if packetrusher binary exists
  try {
    await fs.access(BINARY_PATH);
    console.log(`\n✓ PacketRusher binary found: ${BINARY_PATH}`);
    try {
      await fs.access(BINARY_PATH, fsConstants.X_OK);
      console.log("✓ Binary is executable");
    } catch (err) {
      console.log(
        "⚠ Binary may not be executable. Run: chmod +x ../PacketRusher/packetrusher"
      );
    }
  } catch (err) {
    console.error(`\n✗ PacketRusher binary NOT found at: ${BINARY_PATH}`);
    console.error(
      "Please ensure PacketRusher is built and located in the correct directory"
    );
  }

  // Check if config.yml exists
  try {
    await fs.access(CONFIG_PATH);
    console.log(`✓ Config file found: ${CONFIG_PATH}`);
  } catch (err) {
    console.error(`✗ Config file NOT found at: ${CONFIG_PATH}`);
    console.error(
      "Please ensure config.yml exists in the PacketRusher config directory"
    );
  }

  console.log(
    "\n📱 Open http://localhost:3000 in your browser to start using the controller"
  );
});

// WebSocket Server for HTMX
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("New HTMX WebSocket client connected");
  wsClients.push(ws);

  // Send welcome message as HTML
  ws.send(
    `<div hx-swap-oob="afterbegin:#logs">[${formatTime()}] 🔗 Connected to PacketRusher Controller<br></div>`
  );

  ws.on("close", () => {
    console.log("HTMX WebSocket client disconnected");
    wsClients = wsClients.filter((client) => client !== ws);
  });

  ws.on("error", (error) => {
    console.error("HTMX WebSocket error:", error);
    wsClients = wsClients.filter((client) => client !== ws);
  });
});
