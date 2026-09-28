// build.js -- which build this is.
//
// This copy is the one in the repository, and says so. The deploy writes its
// own over it in the staged site (see scripts/assemble-web.mjs) with the
// commit it was built from, so the title card can say exactly which version
// is running -- on a console browser that caches hard, that is the only way
// to tell whether a change has arrived.
export const BUILD = { hash: 'dev', date: '' };
