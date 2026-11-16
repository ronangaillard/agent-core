// Copy to secrets.h (never committed) and fill in.
#pragma once

#define WIFI_SSID "my-network"
#define WIFI_PASSWORD "..."
// Optional: a second network (e.g. the office); the strongest one in reach is joined.
#define WIFI_SSID_2 ""
#define WIFI_PASSWORD_2 ""
// The agent's status stream: AGENT_STATUS_PORT behind the tunnel, e.g. https://steve.example.com/status
// (http://192.168.1.240:3142/status on the local network).
#define STATUS_URL "https://steve.example.com/status"
#define STATUS_TOKEN "..."  // AGENT_STATUS_TOKEN
