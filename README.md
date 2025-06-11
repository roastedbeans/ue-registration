# PacketRusher UE Registration Controller

A web-based interface for running sequential UE registrations with PacketRusher.

## Setup

Run the setup script to install all dependencies and PacketRusher:

```bash
sudo ./cli.sh setup-packetrusher
```

This will:

- Install system dependencies (build tools, Go, etc.)
- Clone PacketRusher from GitHub
- Copy the custom `config.yml` from this directory to `PacketRusher/config/`
- Build the gtp5g kernel module
- Compile the PacketRusher binary

## Configuration

The `config.yml` in this directory serves as the template configuration that will be copied to PacketRusher during setup. You can modify this file before running the setup script to customize your PacketRusher configuration.

## Usage

After setup, start the web interface:

```bash
npm start
```

Then open http://localhost:4000 in your browser.

## Default Configuration Values

```
key: "465B5CE8B199B49FAA5F0A2EE238A6BC"
opc: "E8ED289DEBA952E4283B54E88E6183CA"
```
