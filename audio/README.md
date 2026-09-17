# Soundtrack

Drop track files in here and list them in `TRACKS` at the top of
`js/music.js`, in the order they should first be heard:

```js
export const TRACKS = [
  'audio/dunes.mp3',
  'audio/nightfall.mp3',
];
```

Anything in this directory is staged into the web build and into the desktop
bundle by `scripts/assemble-web.mjs`. An empty directory, or a listed file
that will not load, costs that file and nothing else — the game runs silent
rather than breaking.

Format: `.mp3` or `.m4a` for reach, `.ogg` if you would rather. Keep an eye on
the size. The rest of the game is about 200 KB of text and loads instantly;
two minutes of stereo at 128 kbps is roughly two megabytes, which is ten times
the whole of the rest of it. 96 kbps mono is plenty for a bed and halves that.
