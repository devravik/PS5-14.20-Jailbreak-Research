#!/bin/bash
# ps5-mitm-setup.sh
# Sets up DNS redirect to deliver WebKit probes to the PS5 browser
# Run as root on your Omarchy/Arch Linux box
#
# Two modes:
#   dns    Simple DNS override (PS5 must set DNS manually)
#   gw     Two NIC gateway (transparent, no PS5 config needed)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

check_root() {
    [[ $EUID -eq 0 ]] || error "Run as root: sudo $0 $*"
}

get_lan_ip() {
    ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' || echo ""
}

install_deps() {
    info "Checking dependencies"
    for pkg in dnsmasq python3; do
        if ! command -v "$pkg" &>/dev/null; then
            warn "$pkg not found, installing"
            pacman -S --noconfirm "$pkg" 2>/dev/null || apt-get install -y "$pkg" 2>/dev/null
        fi
    done
    info "Dependencies ready"
}

# Block Sony update and telemetry domains
SONY_BLOCK_DOMAINS=(
    "fus01.ps5.update.playstation.net"
    "fus02.ps5.update.playstation.net"
    "gs-sec.ww.np.community.playstation.net"
    "telemetry-console.thuuz.com"
)

write_dnsmasq_conf() {
    local lan_ip="$1"
    local conf="/etc/dnsmasq.d/ps5-mitm.conf"

    mkdir -p /etc/dnsmasq.d

    cat > "$conf" <<DNSCONF
# PS5 MITM redirect
# Redirect User Guide to local exploit server
address=/manuals.playstation.net/$lan_ip

# Block update and telemetry
$(for d in "${SONY_BLOCK_DOMAINS[@]}"; do echo "address=/$d/0.0.0.0"; done)

# Captive portal intercept (optional)
address=/psprobe.playstation.net/$lan_ip
DNSCONF

    # Make sure main dnsmasq.conf includes the conf dir
    if ! grep -q "conf-dir=/etc/dnsmasq.d" /etc/dnsmasq.conf 2>/dev/null; then
        echo "conf-dir=/etc/dnsmasq.d/,*.conf" >> /etc/dnsmasq.conf
    fi

    info "dnsmasq config written to $conf"
}

mode_dns() {
    local lan_ip
    lan_ip=$(get_lan_ip)
    [[ -n "$lan_ip" ]] || error "Could not detect LAN IP"

    info "Mode: DNS override"
    info "Your LAN IP: $lan_ip"

    install_deps
    write_dnsmasq_conf "$lan_ip"

    systemctl restart dnsmasq
    info "dnsmasq running"

    echo ""
    info "Setup complete"
    echo ""
    echo "  On the PS5:"
    echo "    Settings > Network > Set Up Internet Connection"
    echo "    Advanced Settings > DNS > Manual"
    echo "    Primary DNS: $lan_ip"
    echo ""
    echo "  Then open: Settings > User's Guide"
    echo "  The PS5 browser will load from your machine instead of Sony."
    echo ""
    echo "  Start the probe server:"
    echo "    python3 $SCRIPT_DIR/host.py"
    echo ""
}

mode_gw() {
    local wan_iface="$1"
    local ps5_iface="$2"
    local ps5_subnet="10.55.0"

    [[ -n "$wan_iface" ]] || error "Usage: $0 gw <wan_iface> <ps5_iface>"
    [[ -n "$ps5_iface" ]] || error "Usage: $0 gw <wan_iface> <ps5_iface>"

    info "Mode: Two NIC gateway"
    info "WAN (to router): $wan_iface"
    info "PS5 (to console): $ps5_iface"

    install_deps

    # Assign static IP to PS5 facing interface
    ip addr flush dev "$ps5_iface" 2>/dev/null || true
    ip addr add "${ps5_subnet}.1/24" dev "$ps5_iface"
    ip link set "$ps5_iface" up
    info "PS5 interface: ${ps5_subnet}.1/24"

    # Enable forwarding
    sysctl -w net.ipv4.ip_forward=1 > /dev/null
    info "IP forwarding enabled"

    # NAT
    iptables -t nat -A POSTROUTING -o "$wan_iface" -j MASQUERADE
    iptables -A FORWARD -i "$ps5_iface" -o "$wan_iface" -j ACCEPT
    iptables -A FORWARD -i "$wan_iface" -o "$ps5_iface" -m state --state RELATED,ESTABLISHED -j ACCEPT
    info "NAT rules set"

    # dnsmasq with DHCP for PS5 interface
    write_dnsmasq_conf "${ps5_subnet}.1"

    cat >> /etc/dnsmasq.d/ps5-mitm.conf <<DHCPCONF

# DHCP for PS5 interface
interface=$ps5_iface
dhcp-range=${ps5_subnet}.10,${ps5_subnet}.50,12h
dhcp-option=option:router,${ps5_subnet}.1
dhcp-option=option:dns-server,${ps5_subnet}.1
DHCPCONF

    systemctl restart dnsmasq
    info "dnsmasq running with DHCP"

    echo ""
    info "Setup complete"
    echo ""
    echo "  Plug PS5 ethernet into: $ps5_iface"
    echo "  No PS5 configuration needed."
    echo "  The PS5 gets an IP automatically and DNS points to this machine."
    echo ""
    echo "  Open: Settings > User's Guide on the PS5"
    echo "  Or: Settings > Network > Test Internet Connection (triggers captive portal)"
    echo ""
    echo "  Start the probe server:"
    echo "    python3 $SCRIPT_DIR/host.py"
    echo ""
}

mode_stop() {
    info "Stopping MITM setup"
    rm -f /etc/dnsmasq.d/ps5-mitm.conf
    systemctl restart dnsmasq 2>/dev/null || true
    iptables -t nat -F 2>/dev/null || true
    iptables -F FORWARD 2>/dev/null || true
    sysctl -w net.ipv4.ip_forward=0 > /dev/null 2>/dev/null || true
    info "Cleaned up"
}

case "${1:-}" in
    dns)
        check_root
        mode_dns
        ;;
    gw)
        check_root
        mode_gw "$2" "$3"
        ;;
    stop)
        check_root
        mode_stop
        ;;
    *)
        echo "PS5 MITM Setup"
        echo ""
        echo "Usage:"
        echo "  sudo $0 dns                     DNS redirect (PS5 sets DNS manually)"
        echo "  sudo $0 gw <wan_if> <ps5_if>    Two NIC gateway (transparent)"
        echo "  sudo $0 stop                    Remove all MITM config"
        echo ""
        echo "Examples:"
        echo "  sudo $0 dns"
        echo "  sudo $0 gw enp3s0 enp4s0"
        ;;
esac
