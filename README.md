# PacketRusher UE Registration Controller

A web-based interface for running sequential UE (User Equipment) registrations with PacketRusher. This tool allows you to automate the registration of multiple UEs one after another, with automatic MSIN (Mobile Subscriber Identification Number) incrementation.

## Features

- **Sequential UE Registration**: Run multiple UE registrations automatically, one after another
- **Automatic MSIN Incrementation**: Each UE gets an incremented MSIN value automatically
- **Real-time Logging**: View session logs and PacketRusher output in real-time via WebSocket
- **Web-based Interface**: Easy-to-use web UI for configuring and monitoring UE registrations
- **Configurable Parameters**: Set MCC, MNC, PLMN, AMF IP/Port, and more through the web interface
- **Progress Tracking**: Monitor the progress of your UE registration session

## Prerequisites

Before installing, ensure you have:

- **Operating System**: Ubuntu/Debian Linux (the setup script uses `apt` package manager)
- **Root/sudo access**: Required for kernel module installation and system package installation
- **Internet connection**: Required for downloading dependencies and cloning PacketRusher
- **Node.js**: Version 14 or higher (check with `node --version`)
- **npm**: Usually comes with Node.js (check with `npm --version`)

### Checking Prerequisites

```bash
# Check Node.js version (should be 14+)
node --version

# Check npm version
npm --version

# Check if you have sudo access
sudo -v
```

If Node.js is not installed, install it:

```bash
# On Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Installation

Follow these steps to install the PacketRusher UE Registration Controller:

### Step 1: Clone or Download the Repository

If you haven't already, navigate to the project directory:

```bash
cd /path/to/ue-scenario/ue-registration
```

### Step 2: Make the Setup Script Executable

Ensure the setup script has execute permissions:

```bash
chmod +x cli.sh
```

### Step 3: Run the Setup Script

This will install all system dependencies, PacketRusher, and build required components:

```bash
sudo ./cli.sh setup-packetrusher
```

**What this script does:**
- Installs system dependencies (build tools, Go 1.24.1, kernel headers, etc.)
- Clones PacketRusher from GitHub into `./PacketRusher/`
- Copies the custom `config.yml` from this directory to `PacketRusher/config/`
- Builds and installs the gtp5g kernel module
- Compiles the PacketRusher binary

**Important Notes:**
- The setup process may take 10-20 minutes depending on your system
- You may be prompted for your sudo password
- After completion, you may need to log out and log back in (or run `source ~/.profile`) for environment variables to take effect

### Step 4: Install Node.js Dependencies

Install the required Node.js packages:

```bash
npm install
```

This will install:
- `express` - Web server framework
- `ws` - WebSocket support
- `js-yaml` - YAML config file parsing
- `cors` - CORS middleware
- `nodemon` - Development auto-reload (dev dependency)

### Step 5: Verify Installation

Verify that everything is installed correctly:

```bash
# Check if PacketRusher binary exists and is executable
ls -l ./PacketRusher/packetrusher

# Check if config file exists
ls -l ./PacketRusher/config/config.yml

# Test PacketRusher (should show help or version)
./PacketRusher/packetrusher --help

# Verify Node.js dependencies
npm list --depth=0
```

### Step 6: (Optional) Reload Environment Variables

If Go or PacketRusher commands are not found, reload your shell environment:

```bash
# Option 1: Source your profile
source ~/.profile

# Option 2: Start a new shell session
# Option 3: Log out and log back in
```

### Installation Complete!

Once all steps are completed, you're ready to use the application. Proceed to the [Usage](#usage) section to learn how to start the web interface.

## Configuration

### Template Configuration

The `config.yml` in this directory serves as the template configuration that will be copied to PacketRusher during setup. You can modify this file before running the setup script to customize your PacketRusher configuration.

**Default Configuration Values:**
- `key`: `465B5CE8B199B49FAA5F0A2EE238A6BC`
- `opc`: `E8ED289DEBA952E4283B54E88E6183CA`

### Runtime Configuration

The web interface allows you to configure UE parameters at runtime without modifying the config file directly. The server automatically updates the PacketRusher config file before each UE registration.

## Usage

### Starting the Web Interface

1. Start the server:

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

2. Open your browser and navigate to:

```
http://localhost:4000
```

### Using the Web Interface

#### 1. Configure UE Parameters

**UE Configuration:**
- **MCC (Mobile Country Code)**: 3-digit country code (e.g., `001` for test network)
- **MNC (Mobile Network Code)**: 2-digit network code (e.g., `01` for test network)
- **Starting MSIN (Mobile Subscriber Identification Number)**: 10-digit starting value (e.g., `0000000001`)
  - This will be the MSIN for the first UE
  - Each subsequent UE will have an incremented MSIN
- **Number of UEs to Run**: How many UEs to register sequentially (1-100000)

**PLMN Configuration:**
- **PLMN MCC**: 3-digit MCC for the visited network (e.g., `999`)
- **PLMN MNC**: 2-digit MNC for the visited network (e.g., `70`)

**AMF Configuration:**
- **AMF IP Address**: IP address of the AMF (Access and Mobility Management Function)
- **AMF Port**: Port number of the AMF (default: `31412`)

#### 2. Start UE Sessions

1. Fill in all required fields in the web interface
2. Click the **"🚀 Start UE Sessions"** button
3. The interface will show:
   - Progress indicator (e.g., "Progress: 3/10 | Current MSIN: 0000000003")
   - Real-time session logs
   - Real-time PacketRusher output

#### 3. Monitor Progress

- **Session Logs**: Shows high-level session information, including when each UE starts/completes
- **PacketRusher Output**: Shows detailed output from the PacketRusher binary for each UE
- **Progress Info**: Displays current progress and the MSIN being processed

#### 4. Control the Session

- **Stop Sessions**: Click the **"⏹️ Stop Sessions"** button to abort the current session
  - The current UE will complete, then the session will stop
- **Clear Logs**: Click the **"🗑️ Clear Logs"** button to clear all log displays

### How It Works

1. When you start a session, the server:
   - Validates all input parameters
   - Sets the starting MSIN value
   - Begins processing UEs sequentially

2. For each UE:
   - Updates the PacketRusher config file with the current MSIN and other parameters
   - Runs `./packetrusher ue` in the PacketRusher directory
   - Captures and displays output in real-time
   - Waits 2 seconds before starting the next UE
   - Increments the MSIN for the next UE

3. The process continues until:
   - All UEs are processed, or
   - You click "Stop Sessions"

## API Endpoints

The server provides the following endpoints:

- `GET /` - Serves the main web interface
- `POST /api/sessions/start` - Start a new UE registration session
- `POST /api/sessions/stop` - Stop the current session
- `POST /api/logs/clear` - Clear all logs
- `GET /health` - Health check endpoint
- `WebSocket /ws` - Real-time log updates via HTMX WebSocket extension

## File Structure

```
ue-registration/
├── cli.sh              # Setup script for installing PacketRusher
├── config.yml          # Template configuration file
├── server.js           # Express.js server with WebSocket support
├── index.html          # Web interface
├── package.json        # Node.js dependencies
├── PacketRusher/       # PacketRusher installation (created by setup)
│   ├── config/
│   │   └── config.yml  # Active configuration (updated at runtime)
│   └── packetrusher    # PacketRusher binary
└── README.md           # This file
```

## Troubleshooting

### PacketRusher Binary Not Found

If you see an error about the PacketRusher binary not being found:

1. Ensure the setup script completed successfully
2. Check that `./PacketRusher/packetrusher` exists and is executable
3. If needed, make it executable: `chmod +x ./PacketRusher/packetrusher`

### Config File Not Found

If you see an error about the config file:

1. Ensure the setup script copied `config.yml` to `PacketRusher/config/`
2. Manually copy if needed: `cp config.yml PacketRusher/config/config.yml`

### Kernel Module Issues

If you encounter issues with the gtp5g kernel module:

- Ensure Secure Boot is disabled
- Check that kernel headers are installed: `apt install linux-headers-$(uname -r)`
- Verify the module is loaded: `lsmod | grep gtp5g`

### Port Already in Use

If port 4000 is already in use:

- Change the `PORT` constant in `server.js` to a different port
- Or stop the process using port 4000: `lsof -ti:4000 | xargs kill`

### WebSocket Connection Issues

If the WebSocket connection fails:

- Check browser console for errors
- Ensure the server is running
- Verify firewall settings allow WebSocket connections

## Development

### Running in Development Mode

```bash
npm run dev
```

This uses `nodemon` to automatically restart the server when files change.

### Project Dependencies

- **express**: Web server framework
- **ws**: WebSocket support
- **js-yaml**: YAML config file parsing
- **cors**: CORS middleware
- **nodemon**: Development auto-reload (dev dependency)

## License

ISC

## Additional Notes

- Each UE registration runs for a maximum of 3 seconds before being terminated
- There's a 2-second delay between UE registrations
- The web interface uses HTMX for dynamic updates without page refreshes
- All logs are kept in memory (last 100 entries per log type)
