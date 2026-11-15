# The agent on an M5StickC Plus2

The agent's face, from its profile picture (26 x 26 cells of 5 px), in landscape, with a panel that says what it is
doing. It streams `GET /status` (Server-Sent Events, see the main README) and redraws at once: no polling.

| state | face | panel |
|---|---|---|
| `idle` | blinks now and then; after 10 min, eyes closed, "z", screen dimmed | au repos / dodo |
| `received` | wide eyes, the hat's lights flash, a "!" | message ! |
| `thinking` | looks up, a light runs along the hat, thought bubbles | il cogite (il lit: triage) |
| `tool` | looks left and right; an icon per tool family (Notion, memory, search, reminder…) | Notion / outil + the tool |
| `writing` | the mouth moves | il ecrit... |
| `coding` | eyes scan, lights cross on the hat | il code + the repository |

Each moment stays at least 1.5 s on screen; the latest one wins. Offline (no Wi-Fi or no stream), the face turns grey
and it reconnects alone, waiting longer each time (2 s to 1 min). No sound. Button A or B: brightness, kept across restarts.

## Build and flash

```bash
cp secrets.example.h secrets.h   # Wi-Fi, STATUS_URL, STATUS_TOKEN (never committed)
python3 certs.py                 # certs.h: the roots behind Cloudflare's certificates, from the system bundle
arduino-cli lib install M5Unified@0.3.0
arduino-cli compile --fqbn esp32:esp32:m5stack_stickc_plus2 --output-dir build .
arduino-cli upload --fqbn esp32:esp32:m5stack_stickc_plus2 -p /dev/cu.usbserial-* --input-dir build .
```

Without `secrets.h` it runs on USB only. A line on the serial port (115200) sets the state, for a test:
`tool notion-search`, `coding agent-core`; `shot` sends the screen back as raw RGB565 (240 x 135, big-endian), after a
`SHOT 240 135` line.

## Troubleshooting

If the screen stays grey, check the Wi-Fi first: the ESP32 only sees 2.4 GHz networks, not 5 GHz.
Then check `STATUS_URL` and `STATUS_TOKEN` in `secrets.h`: a wrong token gets the stream refused, and the face stays grey.
