// The agent's face, cell by cell, from its profile picture (26 x 26): '#' black, 'o' white, '.' background.
#pragma once

static const int FACE_N = 26;
static const char* const FACE[FACE_N] = {
    "..........................",
    "............##............",
    "...........####...........",
    "............##............",
    "........##########........",
    "......##############......",
    ".....#o#o#o#o#o#o#o#......",  // row 6: the hat's band, its lights
    ".....################.....",
    ".....#oooooooooooooo#.....",
    ".....#oooooooooooooo#.....",
    ".....#o#####oo#####o#.....",  // rows 10-13: the glasses
    "....##o#ooo####ooo#o##....",
    "....##o#o#o#oo#o#o#o##....",  // row 12: the pupils, cols 9 and 16
    ".....#o#####oo#####o#.....",
    ".....#oooooo##oooooo#.....",
    ".....##ooooo##oooooo#.....",
    ".....#o###########o##.....",  // row 16: the moustache
    ".....##o#ooooooooo#o#.....",
    ".....#o#ooo####oo#o##.....",  // row 18: the mouth, cols 11-14
    ".....##o#o#o#o#o#o#o#.....",
    "......##o#o#o#o#o#o#......",
    ".......##o#o#o#o#o#.......",
    "........##.#o#o###........",
    ".....####..######..###....",
    "....##.#.#........##.#.#..",
    "..........................",
};

// The lenses' insides (rows 11-12): left cols 8-10, right cols 15-17.
static const int LENS_ROW = 11, LENS_L = 8, LENS_R = 15, LENS_W = 3, LENS_H = 2;
static const int MOUTH_ROW = 18, MOUTH_COL = 11, MOUTH_W = 4;
