// font.js -- a 5x7 bitmap font for the score and messages.
//
// Drawn as rectangles through the same batcher as everything else, so the HUD
// lands in the 320x256 buffer and scales up with hard pixel edges like the
// rest of the picture.

// Each glyph is seven rows of five bits, MSB leftmost, as hex pairs.
const GLYPHS = {
  '0':  '0E11131519110E',
  '1':  '040C040404040E',
  '2':  '0E11010204081F',
  '3':  '1F02040201110E',
  '4':  '02060A121F0202',
  '5':  '1F101E0101110E',
  '6':  '0608101E11110E',
  '7':  '1F010204080808',
  '8':  '0E11110E11110E',
  '9':  '0E11110F01020C',
  'A':  '0E11111F111111',
  'B':  '1E11111E11111E',
  'C':  '0E11101010110E',
  'D':  '1C12111111121C',
  'E':  '1F10101E10101F',
  'F':  '1F10101E101010',
  'G':  '0E11101711110F',
  'H':  '1111111F111111',
  'I':  '0E04040404040E',
  'J':  '0702020202120C',
  'K':  '11121418141211',
  'L':  '1010101010101F',
  'M':  '111B1515111111',
  'N':  '11111915131111',
  'O':  '0E11111111110E',
  'P':  '1E11111E101010',
  'Q':  '0E11111115120D',
  'R':  '1E11111E141211',
  'S':  '0F10100E01011E',
  'T':  '1F040404040404',
  'U':  '1111111111110E',
  'V':  '11111111110A04',
  'W':  '11111115151B11',
  'X':  '11110A040A1111',
  'Y':  '11110A04040404',
  'Z':  '1F01020408101F',
  ' ':  '00000000000000',
  '.':  '00000000000C0C',
  ':':  '000C0C000C0C00',
  '+':  '0004041F040400',
  '-':  '0000001F000000',
  '!':  '04040404040004',
  '/':  '01020204040808',
  '%':  '11020404081111',
  "'":  '04040000000000',
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;
export const CHAR_ADVANCE = 6;

const decoded = new Map();

function rows(ch) {
  let r = decoded.get(ch);
  if (r) return r;
  const hex = GLYPHS[ch] || GLYPHS[' '];
  r = [];
  for (let i = 0; i < GLYPH_H; i++) r.push(parseInt(hex.substr(i * 2, 2), 16));
  decoded.set(ch, r);
  return r;
}

export function textWidth(s, scale = 1) {
  return s.length * CHAR_ADVANCE * scale;
}

// Draw a string. Each set pixel becomes one `scale`-sized rectangle.
export function drawText(rd, s, x, y, col, scale = 1) {
  s = String(s).toUpperCase();
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

export function drawTextCentred(rd, s, cx, y, col, scale = 1) {
  drawText(rd, s, Math.round(cx - textWidth(s, scale) / 2), y, col, scale);
}
