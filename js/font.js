// font.js -- a 5x8 bitmap font for the score and messages.
//
// Drawn as rectangles through the same batcher as everything else, so the HUD
// lands in the 320x256 buffer and scales up with hard pixel edges like the
// rest of the picture.
//
// It began as caps only, seven rows tall, because that is what a HUD that
// shouts needs and it is what the machines this is a tribute to had. The game
// does not shout any more, and a line of capitals reads as an instruction
// however gently it is worded -- so there is a lowercase now, and the cell
// grew a row to hold the tails of g, j, p, q and y.
//
// Proportions are the ordinary ones: capitals seven rows, lowercase five,
// ascenders the full seven, one row below the baseline for descenders. The
// five-row x-height against a seven-row cap is about the ratio a real face
// uses, which is why it reads as lowercase rather than as small capitals.

// Each glyph is eight rows of five bits, MSB leftmost, as hex pairs. The
// baseline is row 6; row 7 exists only for descenders and is blank in almost
// every glyph.
const GLYPHS = {
  '0':  '0E11131519110E00',
  '1':  '040C040404040E00',
  '2':  '0E11010204081F00',
  '3':  '1F02040201110E00',
  '4':  '02060A121F020200',
  '5':  '1F101E0101110E00',
  '6':  '0608101E11110E00',
  '7':  '1F01020408080800',
  '8':  '0E11110E11110E00',
  '9':  '0E11110F01020C00',

  'A':  '0E11111F11111100',
  'B':  '1E11111E11111E00',
  'C':  '0E11101010110E00',
  'D':  '1C12111111121C00',
  'E':  '1F10101E10101F00',
  'F':  '1F10101E10101000',
  'G':  '0E11101711110F00',
  'H':  '1111111F11111100',
  'I':  '0E04040404040E00',
  'J':  '0702020202120C00',
  'K':  '1112141814121100',
  'L':  '1010101010101F00',
  'M':  '111B151511111100',
  'N':  '1111191513111100',
  'O':  '0E11111111110E00',
  'P':  '1E11111E10101000',
  'Q':  '0E11111115120D00',
  'R':  '1E11111E14121100',
  'S':  '0F10100E01011E00',
  'T':  '1F04040404040400',
  'U':  '1111111111110E00',
  'V':  '11111111110A0400',
  'W':  '11111115151B1100',
  'X':  '11110A040A111100',
  'Y':  '11110A0404040400',
  'Z':  '1F01020408101F00',

  // Lowercase: x-height rows 2-6, ascenders from row 0, descenders in row 7.
  'a':  '00000E010F110F00',
  'b':  '10101E1111111E00',
  'c':  '00000F1010100F00',
  'd':  '01010F1111110F00',
  'e':  '00000E111F100E00',
  'f':  '06081E0808080800',
  'g':  '00000F11110F010E',
  'h':  '10101E1111111100',
  'i':  '0800080808080800',
  'j':  '020002020202021C',
  'k':  '1010121418141200',
  'l':  '1808080808080E00',
  'm':  '00001B1515151500',
  'n':  '00001E1111111100',
  'o':  '00000E1111110E00',
  'p':  '00001E11111E1010',
  'q':  '00000F11110F0101',
  'r':  '0000161810101000',
  's':  '00000F100E011E00',
  't':  '08081E0808090600',
  'u':  '0000111111110F00',
  'v':  '00001111110A0400',
  'w':  '0000111115150A00',
  'x':  '0000110A040A1100',
  'y':  '00001111110F011C',
  'z':  '00001F0204081F00',

  ' ':  '0000000000000000',
  '.':  '00000000000C0C00',
  ',':  '00000000000C0C08',
  ':':  '00000C0C000C0C00',
  '+':  '0004041F04040000',
  '-':  '0000001F00000000',
  '!':  '0404040404000400',
  '?':  '0E11010204000400',
  '/':  '0102020404080800',
  '%':  '1102040408111100',
  "'":  '0404000000000000',
};

export const GLYPH_W = 5;
export const GLYPH_H = 8;
export const CHAR_ADVANCE = 6;

const decoded = new Map();

function rows(ch) {
  let r = decoded.get(ch);
  if (r) return r;
  // A character with no glyph of its own falls back to its capital before it
  // falls back to a space, so nothing silently disappears from a line.
  const hex = GLYPHS[ch] || GLYPHS[ch.toUpperCase()] || GLYPHS[' '];
  r = [];
  for (let i = 0; i < GLYPH_H; i++) r.push(parseInt(hex.substr(i * 2, 2), 16));
  decoded.set(ch, r);
  return r;
}

export function textWidth(s, scale = 1) {
  return s.length * CHAR_ADVANCE * scale;
}

// Every line is drawn over a sky that moves through the whole day and over
// ground that is pale sand in one place and wet slate in another. Text that
// stays readable on all of it has two options: shout -- hard white, or a box
// behind it -- or sit on its own shadow. One offset pixel of translucent dark
// costs a second pass over the glyph and lets the text itself stay a soft
// colour, which is the entire point.
const SHADOW = [20, 24, 30, 120];

function emit(rd, s, x, y, col, scale) {
  let cx = x;
  for (let i = 0; i < s.length; i++) {
    const g = rows(s[i]);
    for (let ry = 0; ry < GLYPH_H; ry++) {
      const bits = g[ry];
      if (!bits) continue;
      // Coalesce runs of set pixels into one rectangle to save vertices.
      let run = 0;
      for (let rx = 0; rx <= GLYPH_W; rx++) {
        const on = rx < GLYPH_W && (bits & (1 << (GLYPH_W - 1 - rx)));
        if (on) { run++; continue; }
        if (run) {
          rd.rect(cx + (rx - run) * scale, y + ry * scale, run * scale, scale, col);
          run = 0;
        }
      }
    }
    cx += CHAR_ADVANCE * scale;
  }
  return cx;
}

// Draw a string. Each set pixel becomes one `scale`-sized rectangle.
export function drawText(rd, s, x, y, col, scale = 1, shadow = true) {
  s = String(s);
  if (shadow) emit(rd, s, x + scale, y + scale, SHADOW, scale);
  return emit(rd, s, x, y, col, scale);
}

export function drawTextCentred(rd, s, cx, y, col, scale = 1, shadow = true) {
  drawText(rd, s, Math.round(cx - textWidth(s, scale) / 2), y, col, scale, shadow);
}
