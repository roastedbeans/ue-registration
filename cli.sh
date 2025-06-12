#!/bin/bash

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        print_error "This script must be run as root (use sudo)"
        exit 1
    fi
}

# Function to get the actual user (not root when using sudo)
get_actual_user() {
    if [[ -n "$SUDO_USER" ]]; then
        echo "$SUDO_USER"
    else
        echo "$USER"
    fi
}

# Function to get the actual user's home directory
get_actual_home() {
    local actual_user=$(get_actual_user)
    eval echo "~$actual_user"
}

# Function to install system dependencies
install_system_deps() {
    print_status "Installing system dependencies..."
    
    # Update package list
    apt update
    
    # Install required packages
    apt install -y build-essential linux-headers-generic make git wget tar linux-modules-extra-$(uname -r)
    
    print_success "System dependencies installed successfully"
}

# Function to install Go
install_go() {
    print_status "Installing Go 1.24.1..."
    
    local actual_home=$(get_actual_home)
    local actual_user=$(get_actual_user)
    
    # Download Go
    cd /tmp
    wget https://go.dev/dl/go1.24.1.linux-amd64.tar.gz
    
    # Remove existing Go installation and install new one
    rm -rf /usr/local/go
    tar -C /usr/local -xzf go1.24.1.linux-amd64.tar.gz
    
    # Add Go to PATH in user's .profile
    if ! grep -q 'export PATH=$PATH:/usr/local/go/bin' "$actual_home/.profile" 2>/dev/null; then
        echo 'export PATH=$PATH:/usr/local/go/bin' >> "$actual_home/.profile"
        chown "$actual_user:$actual_user" "$actual_home/.profile"
    fi
    
    # Also add to .bashrc for immediate availability
    if ! grep -q 'export PATH=$PATH:/usr/local/go/bin' "$actual_home/.bashrc" 2>/dev/null; then
        echo 'export PATH=$PATH:/usr/local/go/bin' >> "$actual_home/.bashrc"
        chown "$actual_user:$actual_user" "$actual_home/.bashrc"
    fi
    
    # Clean up
    rm -f go1.24.1.linux-amd64.tar.gz
    
    print_success "Go 1.24.1 installed successfully"
}

# Function to clone and setup PacketRusher
setup_packetrusher() {
    print_status "Setting up PacketRusher..."
    
    local actual_home=$(get_actual_home)
    local actual_user=$(get_actual_user)
    local current_dir=$(pwd)
    local packetrusher_dir="$current_dir/PacketRusher"
    
    # Clone PacketRusher if it doesn't exist
    if [[ ! -d "$packetrusher_dir" ]]; then
        print_status "Cloning PacketRusher repository..."
        sudo -u "$actual_user" git clone https://github.com/HewlettPackard/PacketRusher "$packetrusher_dir"
    else
        print_status "PacketRusher directory already exists, updating..."
        cd "$packetrusher_dir"
        sudo -u "$actual_user" git pull
        cd "$current_dir"
    fi
    
    # Add PACKETRUSHER environment variable to .profile
    if ! grep -q "export PACKETRUSHER=" "$actual_home/.profile" 2>/dev/null; then
        echo "export PACKETRUSHER=$packetrusher_dir" >> "$actual_home/.profile"
        chown "$actual_user:$actual_user" "$actual_home/.profile"
    fi
    
    # Also add to .bashrc for immediate availability
    if ! grep -q "export PACKETRUSHER=" "$actual_home/.bashrc" 2>/dev/null; then
        echo "export PACKETRUSHER=$packetrusher_dir" >> "$actual_home/.bashrc"
        chown "$actual_user:$actual_user" "$actual_home/.bashrc"
    fi
    
    # Copy custom config.yml from root to PacketRusher config directory  
    if [[ -f "$current_dir/config.yml" ]]; then
        print_status "Copying custom config.yml to PacketRusher..."
        cp "$current_dir/config.yml" "$packetrusher_dir/config/config.yml"
        chown "$actual_user:$actual_user" "$packetrusher_dir/config/config.yml"
        print_success "Custom config.yml copied successfully"
    else
        print_warning "No custom config.yml found in root directory, using PacketRusher's default"
    fi
    
    print_success "PacketRusher repository setup completed"
}

# Function to build gtp5g kernel module
build_gtp5g() {
    print_status "Building free5gc's gtp5g kernel module..."
    
    local actual_home=$(get_actual_home)
    local actual_user=$(get_actual_user)
    local current_dir=$(pwd)
    local packetrusher_dir="$current_dir/PacketRusher"
    local gtp5g_dir="$packetrusher_dir/lib/gtp5g"
    
    print_status "Checking gtp5g directory: $gtp5g_dir"
    
    if [[ ! -d "$gtp5g_dir" ]]; then
        print_error "gtp5g directory not found at $gtp5g_dir"
        print_error "Current working directory: $(pwd)"
        print_error "PacketRusher directory: $packetrusher_dir"
        exit 1
    fi
    
    print_status "Entering gtp5g directory..."
    cd "$gtp5g_dir" || {
        print_error "Failed to change to gtp5g directory: $gtp5g_dir"
        exit 1
    }
    
    # Clean, build, and install
    print_status "Running make clean..."
    make clean
    print_status "Running make..."
    make
    print_status "Running make install..."
    make install
    
    # Return to original directory
    cd "$current_dir" || {
        print_error "Failed to return to original directory: $current_dir"
        exit 1
    }
    
    print_success "gtp5g kernel module built and installed successfully"
    print_warning "Note: Make sure Secure Boot is disabled if you encounter issues with the kernel module"
}

# Function to build PacketRusher CLI
build_packetrusher_cli() {
    print_status "Building PacketRusher CLI..."
    
    local actual_home=$(get_actual_home)
    local actual_user=$(get_actual_user)
    local current_dir=$(pwd)
    local packetrusher_dir="$current_dir/PacketRusher"
    
    print_status "Checking PacketRusher directory: $packetrusher_dir"
    
    if [[ ! -d "$packetrusher_dir" ]]; then
        print_error "PacketRusher directory not found at $packetrusher_dir"
        print_error "Current working directory: $(pwd)"
        exit 1
    fi
    
    print_status "Entering PacketRusher directory..."
    cd "$packetrusher_dir" || {
        print_error "Failed to change to PacketRusher directory: $packetrusher_dir"
        exit 1
    }
    
    # Set up Go environment
    export PATH=$PATH:/usr/local/go/bin
    
    print_status "Downloading Go modules..."
    sudo -u "$actual_user" -E /usr/local/go/bin/go mod download
    
    print_status "Building PacketRusher binary..."
    sudo -u "$actual_user" -E /usr/local/go/bin/go build cmd/packetrusher.go
    
    # Make the binary executable
    chmod +x packetrusher
    chown "$actual_user:$actual_user" packetrusher
    
    # Return to original directory
    cd "$current_dir" || {
        print_error "Failed to return to original directory: $current_dir"
        exit 1
    }
    
    print_success "PacketRusher CLI built successfully"
    print_status "Testing PacketRusher CLI..."
    
    # Test the CLI
    if sudo -u "$actual_user" "$packetrusher_dir/packetrusher" --help >/dev/null 2>&1; then
        print_success "PacketRusher CLI is working correctly"
    else
        print_warning "PacketRusher CLI test failed, but binary was created"
    fi
}

# Function to display completion message
display_completion() {
    local actual_home=$(get_actual_home)
    local actual_user=$(get_actual_user)
    local current_dir=$(pwd)
    local packetrusher_dir="$current_dir/PacketRusher"
    
    print_success "PacketRusher setup completed successfully!"
    echo ""
    echo -e "${GREEN}Next steps:${NC}"
    echo "1. Log out and log back in, or run: source ~/.profile"
    echo "2. Navigate to the PacketRusher directory: cd PacketRusher"
    echo "3. Run PacketRusher: ./packetrusher --help"
    echo ""
    echo -e "${BLUE}Installation Summary:${NC}"
    echo "- System dependencies: Installed"
    echo "- Go 1.24.1: Installed at /usr/local/go"
    echo "- PacketRusher: Cloned to $packetrusher_dir"
    echo "- Custom config.yml: Copied to PacketRusher/config/"
    echo "- gtp5g kernel module: Built and installed"
    echo "- PacketRusher CLI: Built and ready to use"
    echo ""
    echo -e "${YELLOW}Important Notes:${NC}"
    echo "- Make sure Secure Boot is disabled for the kernel module to work"
    echo "- Environment variables have been added to ~/.profile and ~/.bashrc"
    echo "- You may need to restart your shell or run 'source ~/.profile' to use Go and PacketRusher"
}

# Main setup function
setup_packetrusher_main() {
    print_status "Starting PacketRusher setup..."
    
    check_root
    
    # Check if we're on Ubuntu/Debian
    if ! command -v apt >/dev/null 2>&1; then
        print_error "This script is designed for Ubuntu/Debian systems with apt package manager"
        exit 1
    fi
    
    # Execute setup steps
    install_system_deps
    install_go
    setup_packetrusher
    build_gtp5g
    build_packetrusher_cli
    display_completion
}

# Function to display help
show_help() {
    echo "PacketRusher Setup Script"
    echo ""
    echo "Usage: sudo ./cli.sh <command>"
    echo ""
    echo "Commands:"
    echo "  setup-packetrusher    Install all dependencies and setup PacketRusher"
    echo "  help                  Show this help message"
    echo ""
    echo "Example:"
    echo "  sudo ./cli.sh setup-packetrusher"
}

# Main script logic
case "${1:-}" in
    setup-packetrusher)
        setup_packetrusher_main
        ;;
    help)
        show_help
        ;;
    *)
        echo "Invalid command or no command provided."
        echo ""
        show_help
        exit 1
        ;;
esac
