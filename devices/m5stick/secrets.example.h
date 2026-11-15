// Copy to secrets.h (never committed) and fill in.
#pragma once

#define WIFI_SSID "my-network"
#define WIFI_PASSWORD "..."
// The agent's status stream: AGENT_STATUS_PORT behind the tunnel, e.g. https://steve.example.com/status
// (http://192.168.1.240:3142/status on the local network).
#define STATUS_URL "https://steve.example.com/status"
#define STATUS_TOKEN "..."  // AGENT_STATUS_TOKEN
