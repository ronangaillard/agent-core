// The agent on an M5StickC Plus2: its face (from its profile picture) shows what it is doing, streamed live from
// agent-core's GET /status (Server-Sent Events). Silent. Button A or B: brightness.
// For a test without Wi-Fi, a line on the USB serial port sets the state: "tool notion-search", "coding agent-core".

#include <M5Unified.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <WiFiClientSecure.h>

#include "certs.h"
#include "face.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define STATUS_URL ""
#define STATUS_TOKEN ""
#endif
// A second network, optional (e.g. home and office): the strongest one in reach is joined.
#ifndef WIFI_SSID_2
#define WIFI_SSID_2 ""
#define WIFI_PASSWORD_2 ""
#endif

// --- palette (the profile picture's) and layout ------------------------------------------------------------------
static const uint16_t C_YELLOW = 0xF5E6;  // #F4BE34
static const uint16_t C_BLACK = 0x0000, C_WHITE = 0xFFFF, C_GREY = 0x7BEF, C_RED = 0xF800, C_GREEN = 0x07E0;
// Landscape: the face on the left (26 cells of 5 px, 130 px), a panel on the right.
static const int W = 240, H = 135, CELL = 5, FX = 3, FY = 2;
static const int PANEL_X = 136, PANEL_W = W - PANEL_X - 3;

M5Canvas canvas(&M5.Display);
Preferences prefs;

// --- the status, shared between the network task and the drawing loop ---------------------------------------------
enum State { IDLE, RECEIVED, THINKING, TOOL, WRITING, CODING, UNKNOWN };
struct Status {
  State state = IDLE;
  char detail[40] = "";
  int tasks = 0;
};
static QueueHandle_t updates;
static volatile bool online = false;  // the stream is open
static volatile bool hasWifi = false;

State stateOf(const String& s) {
  if (s == "idle") return IDLE;
  if (s == "received") return RECEIVED;
  if (s == "thinking") return THINKING;
  if (s == "tool") return TOOL;
  if (s == "writing") return WRITING;
  if (s == "coding") return CODING;
  return UNKNOWN;
}

void push(const String& state, const String& detail, int tasks) {
  Status s;
  s.state = stateOf(state);
  if (s.state == UNKNOWN) return;
  strlcpy(s.detail, detail.c_str(), sizeof(s.detail));
  s.tasks = tasks;
  xQueueOverwrite(updates, &s);
}

// --- the stream: Wi-Fi, then GET /status, read line by line (chunked or not), reconnected with a growing pause -----
String jsonString(const String& json, const char* key) {
  String k = String("\"") + key + "\":\"";
  int at = json.indexOf(k);
  if (at < 0) return "";
  at += k.length();
  int end = json.indexOf('"', at);
  return end < 0 ? "" : json.substring(at, end);
}

int jsonInt(const String& json, const char* key) {
  String k = String("\"") + key + "\":";
  int at = json.indexOf(k);
  return at < 0 ? 0 : json.substring(at + k.length()).toInt();
}

void stream() {
  String url = STATUS_URL;
  bool tls = url.startsWith("https://");
  String rest = url.substring(tls ? 8 : 7);
  int slash = rest.indexOf('/');
  String hostPort = slash < 0 ? rest : rest.substring(0, slash);
  String path = slash < 0 ? "/" : rest.substring(slash);
  int colon = hostPort.indexOf(':');
  String host = colon < 0 ? hostPort : hostPort.substring(0, colon);
  int port = colon < 0 ? (tls ? 443 : 80) : hostPort.substring(colon + 1).toInt();

  WiFiClientSecure secure;
  WiFiClient plain;
  if (tls) secure.setCACert(ROOT_CAS);
  WiFiClient& client = tls ? (WiFiClient&)secure : plain;
  if (!client.connect(host.c_str(), port, 10000)) return;
  client.printf("GET %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nAccept: text/event-stream\r\nCache-Control: no-cache\r\n\r\n", path.c_str(),
                host.c_str(), STATUS_TOKEN);

  // Headers.
  bool chunked = false, ok = false, first = true;
  uint32_t last = millis();
  String line;
  while (client.connected() && millis() - last < 15000) {
    if (!client.available()) {
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    line = client.readStringUntil('\n');
    line.trim();
    if (first) ok = line.indexOf(" 200") > 0, first = false;
    else if (line.equalsIgnoreCase("transfer-encoding: chunked")) chunked = true;
    else if (line.length() == 0) break;
  }
  if (!ok) return client.stop();
  online = true;

  // Body: SSE lines; a 25 s heartbeat comes from the server, so 70 s of silence means a dead link.
  long chunkLeft = chunked ? -1 : LONG_MAX;  // -1: a chunk size line comes next
  String chunkLine, sse;
  last = millis();
  while (client.connected() && millis() - last < 70000) {
    if (!client.available()) {
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    char c = client.read();
    last = millis();
    if (chunkLeft < 0) {  // reading a chunk's size
      if (c == '\n') {
        chunkLine.trim();
        if (chunkLine.length()) chunkLeft = strtol(chunkLine.c_str(), nullptr, 16);
        chunkLine = "";
        if (chunkLeft == 0) break;
      } else chunkLine += c;
      continue;
    }
    if (chunked && --chunkLeft == 0) chunkLeft = -1;  // the CRLF after the data reads as an empty size line
    if (c == '\r') continue;
    if (c != '\n') {
      if (sse.length() < 512) sse += c;
      continue;
    }
    if (sse.startsWith("data: ")) {
      String json = sse.substring(6);
      push(jsonString(json, "state"), jsonString(json, "detail"), jsonInt(json, "tasks"));
    }
    sse = "";
  }
  client.stop();
}

void network(void*) {
  if (strlen(WIFI_SSID) == 0 || strlen(STATUS_URL) == 0) vTaskDelete(nullptr);  // serial only
  WiFi.mode(WIFI_STA);
  WiFiMulti networks;
  networks.addAP(WIFI_SSID, WIFI_PASSWORD);
  if (strlen(WIFI_SSID_2) > 0) networks.addAP(WIFI_SSID_2, WIFI_PASSWORD_2);
  uint32_t pause = 2000;
  for (;;) {
    // Joins (or rejoins) the strongest known network in reach.
    hasWifi = networks.run(10000) == WL_CONNECTED;
    if (!hasWifi) {
      online = false;
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }
    uint32_t started = millis();
    stream();
    online = false;
    if (millis() - started > 60000) pause = 2000;  // it held: start over gently
    vTaskDelay(pdMS_TO_TICKS(pause));
    pause = min<uint32_t>(pause * 2, 60000);
  }
}

// --- the face ------------------------------------------------------------------------------------------------------
void cell(int x, int y, uint16_t color) { canvas.fillRect(FX + x * CELL, FY + y * CELL, CELL, CELL, color); }

void baseFace(uint16_t bg, uint16_t ink) {
  canvas.fillScreen(bg);
  for (int y = 0; y < FACE_N; y++)
    for (int x = 0; x < FACE_N; x++) {
      char c = FACE[y][x];
      if (c != '.') cell(x, y, c == '#' ? ink : C_WHITE);
    }
}

// The pupils at (px, py) in each lens (3 x 2); closed: a line; wide: 2 x 2.
void eyes(int px, int py, bool closed = false, bool wide = false) {
  for (int lens : {LENS_L, LENS_R})
    for (int y = 0; y < LENS_H; y++)
      for (int x = 0; x < LENS_W; x++) {
        bool on = closed ? y == 1 : wide ? (x >= px && x <= px + 1) : (x == px && y == py);
        cell(lens + x, LENS_ROW + y, on ? C_BLACK : C_WHITE);
      }
}

void mouth(bool open) {
  if (!open) return;
  for (int x = 0; x < MOUTH_W; x++) cell(MOUTH_COL + x, MOUTH_ROW + 1, C_BLACK);
}

// The hat's lights (row 6, cols 6..18 even): `lit` says which are on.
void band(uint32_t lit) {
  for (int i = 0; i < 7; i++) cell(6 + i * 2, 6, (lit >> i) & 1 ? C_WHITE : C_BLACK);
}

// A small pixel icon (7 x 7, 3 px), for a tool.
void icon(const char* const rows[7], int x0, int y0, uint16_t color) {
  for (int y = 0; y < 7; y++)
    for (int x = 0; x < 7; x++)
      if (rows[y][x] == '#') canvas.fillRect(x0 + x * 3, y0 + y * 3, 3, 3, color);
}
static const char* const ICON_SEARCH[7] = {".###...", "#...#..", "#...#..", "#...#..", ".###...", "....##.", ".....##"};
static const char* const ICON_NOTION[7] = {"#######", "##...##", "#.#..##", "#..#.##", "#...###", "##...##", "#######"};
static const char* const ICON_BOOK[7] = {"##.##..", "#.#.#..", "#.#.#..", "#.#.#..", "#.#.#..", "##.##..", "..#...."};
static const char* const ICON_EYE[7] = {".......", "..###..", ".#...#.", "#..#..#", ".#...#.", "..###..", "......."};
static const char* const ICON_SEND[7] = {"...#...", "....#..", "#######", "....#..", "...#...", ".......", "......."};
static const char* const ICON_CLOCK[7] = {".#####.", "#..#..#", "#..#..#", "#..##.#", "#.....#", "#.....#", ".#####."};
static const char* const ICON_CODE[7] = {"..#.#..", ".#...#.", "#.....#", "#.....#", ".#...#.", "..#.#..", "......."};
static const char* const ICON_FILE[7] = {"####...", "#..##..", "#...##.", "#....#.", "#....#.", "#....#.", "######."};
static const char* const ICON_GEAR[7] = {"..#.#..", ".#####.", "##...##", ".#.#.#.", "##...##", ".#####.", "..#.#.."};

// A tool's name → its icon and a short word.
const char* const* toolIcon(const String& t, String& word) {
  word = t;
  if (t.startsWith("notion-")) return word = t.substring(7), ICON_NOTION;
  if (t.startsWith("memory_")) return word = t.substring(7), ICON_BOOK;
  if (t.startsWith("search_")) return word = t.substring(7), ICON_SEARCH;
  if (t == "read_conversation") return word = "conversation", ICON_EYE;
  if (t == "open_file") return word = "fichier", ICON_FILE;
  if (t == "send") return word = "envoi", ICON_SEND;
  if (t.endsWith("_reminder") || t == "list_reminders") return word = "rappel", ICON_CLOCK;
  if (t.endsWith("_code_task")) return word = "tache", ICON_CODE;
  return ICON_GEAR;
}

// --- drawing loop --------------------------------------------------------------------------------------------------
Status shown, target;
uint32_t shownAt = 0, idleSince = 0, nextBlink = 3000;
int brightness = 2;  // index in LEVELS
static const uint8_t LEVELS[] = {30, 80, 140, 220};
uint32_t toastUntil = 0;
String toast;

uint32_t holdOf(State s) { return s == IDLE || s == CODING ? 0 : s == RECEIVED ? 1800 : 1500; }

void panel(const char* const* ic, const String& title, const String& sub, uint16_t ink) {
  canvas.fillRoundRect(PANEL_X, 4, PANEL_W, 108, 8, C_BLACK);
  int x = PANEL_X + 7;
  if (ic) icon(ic, x, 12, C_YELLOW);
  canvas.setTextColor(ink);
  canvas.setFont(&fonts::FreeSansBold9pt7b);
  canvas.setTextDatum(top_left);
  canvas.drawString(title, x, 42);
  canvas.setFont(&fonts::Font2);
  canvas.setTextColor(C_WHITE);
  canvas.setClipRect(PANEL_X, 4, PANEL_W - 4, 108);
  canvas.drawString(sub, x, 72);
  canvas.clearClipRect();
}

void footer(uint32_t now) {
  canvas.setFont(&fonts::Font0);
  canvas.setTextDatum(bottom_left);
  bool wireless = strlen(WIFI_SSID) > 0;
  uint16_t dot = !wireless ? C_GREY : online ? C_GREEN : C_RED;
  canvas.fillCircle(PANEL_X + 5, H - 7, 3, dot);
  canvas.setTextColor(C_BLACK);
  canvas.drawString(!wireless ? "usb" : online ? "en ligne" : hasWifi ? "connexion..." : "wifi...", PANEL_X + 12, H - 2);
  canvas.setTextDatum(bottom_right);
  int level = M5.Power.getBatteryLevel();
  canvas.drawString(level >= 0 ? String(level) + "%" : "", W - 4, H - 2);
}

void draw(uint32_t now) {
  bool off = strlen(WIFI_SSID) > 0 && !online;
  bool dozing = shown.state == IDLE && now - idleSince > 10 * 60 * 1000;
  uint16_t bg = off ? C_GREY : C_YELLOW;
  baseFace(bg, C_BLACK);
  uint32_t t = now - shownAt;
  String word;
  const char* const* ic = nullptr;
  String title, sub = shown.detail;

  switch (shown.state) {
    case IDLE: {
      bool blink = now >= nextBlink && now < nextBlink + 140;
      if (now >= nextBlink + 140) nextBlink = now + 2500 + esp_random() % 4000;
      if (dozing) {
        eyes(0, 0, true);
        band(0);
        int z = (now / 600) % 3;
        canvas.setFont(&fonts::Font2);
        canvas.setTextColor(C_BLACK);
        for (int i = 0; i <= z; i++) canvas.drawString("z", FX + (21 + i) * CELL, FY + (4 - i * 2) * CELL);
        title = "dodo";
      } else {
        eyes(1, 1, blink);
        band(0x7F);
        title = "au repos";
      }
      if (sub.length() == 0) sub = off ? "hors ligne" : "rien a faire";
      break;
    }
    case RECEIVED: {
      eyes(0, 0, false, true);
      band((now / 150) % 2 ? 0x7F : 0);
      if ((now / 250) % 2 == 0) {  // a "!" by the head
        for (int y = 0; y < 3; y++) cell(23, y, C_BLACK);
        cell(23, 4, C_BLACK);
      }
      title = "message !";
      if (sub == "event") sub = "un evenement";
      break;
    }
    case THINKING: {
      eyes(2, 0);
      band(1u << ((now / 180) % 7));
      int dots = (t / 400) % 4;  // thought bubbles, growing
      if (dots > 0) cell(21, 4, C_BLACK);
      if (dots > 1) cell(23, 2, C_BLACK);
      if (dots > 2) cell(24, 0, C_BLACK), cell(25, 0, C_BLACK);
      title = sub == "triage" ? "il lit" : "il cogite";
      sub = sub == "triage" ? "en parle-t-on ?" : "";
      break;
    }
    case TOOL: {
      int look = (now / 500) % 2 ? 0 : 2;
      eyes(look, 1);
      band(0x55 >> ((now / 250) % 2));
      ic = toolIcon(String(shown.detail), word);
      title = word != shown.detail && strncmp(shown.detail, "notion-", 7) == 0 ? "Notion" : "outil";
      sub = word;
      break;
    }
    case WRITING: {
      eyes(1, 1, (now % 3000) < 120);
      mouth((now / 160) % 2);
      band(0x7F);
      title = "il ecrit...";
      break;
    }
    case CODING: {
      eyes((now / 700) % 3, 1);
      band(1u << ((now / 120) % 7) | 1u << (6 - (now / 120) % 7));
      ic = ICON_CODE;
      title = "il code";
      if (shown.tasks > 1) sub += " +" + String(shown.tasks - 1);
      break;
    }
    default:
      break;
  }
  panel(ic, title, toastUntil > now ? toast : sub, C_YELLOW);
  footer(now);
  canvas.pushSprite(0, 0);
  M5.Display.setBrightness(dozing ? 15 : LEVELS[brightness]);
}

void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);
  Serial.begin(115200);
  M5.Display.setRotation(1);
  canvas.setPsram(true);
  canvas.setColorDepth(16);
  canvas.createSprite(W, H);
  prefs.begin("steve", false);
  brightness = prefs.getInt("bright", 2);
  M5.Speaker.end();
  updates = xQueueCreate(1, sizeof(Status));
  xTaskCreatePinnedToCore(network, "network", 12288, nullptr, 1, nullptr, 0);
  shownAt = idleSince = millis();
}

void loop() {
  M5.update();
  uint32_t now = millis();

  if (M5.BtnA.wasPressed() || M5.BtnB.wasPressed()) {
    brightness = (brightness + 1) % 4;
    prefs.putInt("bright", brightness);
    toast = "luminosite " + String(brightness + 1) + "/4", toastUntil = now + 1500;
  }
  if (Serial.available()) {  // tests: "state detail"
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line == "shot") {  // the screen as raw RGB565, for a look from the computer
      Serial.printf("SHOT %d %d\n", W, H);
      Serial.write((const uint8_t*)canvas.getBuffer(), W * H * 2);
      Serial.println();
      return;
    }
    int space = line.indexOf(' ');
    push(space < 0 ? line : line.substring(0, space), space < 0 ? "" : line.substring(space + 1), 0);
  }

  Status s;
  if (xQueueReceive(updates, &s, 0) == pdTRUE) target = s;
  // Each moment stays long enough to be seen; the latest one wins.
  bool changed = target.state != shown.state || strcmp(target.detail, shown.detail) != 0 || target.tasks != shown.tasks;
  if (changed && now - shownAt >= holdOf(shown.state)) {
    if (target.state == IDLE && shown.state != IDLE) idleSince = now;
    if (target.state != IDLE) idleSince = now;
    shown = target;
    shownAt = now;
  }
  draw(now);
  delay(33);
}
