// decode.mjs -- pull the geometry and UVs out of a Draco-compressed GLB.
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const draco3d = require('draco3d');

const file = process.argv[2];
const b = fs.readFileSync(file);
let off = 12; const chunks = {};
while (off < b.length) {
  const len = b.readUInt32LE(off), type = b.toString('ascii', off + 4, off + 8).replace(/\0/g, '');
  chunks[type] = b.subarray(off + 8, off + 8 + len);
  off += 8 + len;
}
const gltf = JSON.parse(chunks.JSON.toString('utf8'));
const bin = chunks.BIN;
const view = (i) => {
  const v = gltf.bufferViews[i];
  return bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
};

const prim = gltf.meshes[0].primitives[0];
const dracoExt = prim.extensions.KHR_draco_mesh_compression;
const buf = view(dracoExt.bufferView);

const decoderModule = await draco3d.createDecoderModule({});
const decoder = new decoderModule.Decoder();
const dracoBuf = new decoderModule.DecoderBuffer();
dracoBuf.Init(new Int8Array(buf), buf.length);
const type = decoder.GetEncodedGeometryType(dracoBuf);
const mesh = new decoderModule.Mesh();
const status = decoder.DecodeBufferToMesh(dracoBuf, mesh);
if (!status.ok()) throw new Error('draco: ' + status.error_msg());

const numFaces = mesh.num_faces(), numPoints = mesh.num_points();
const idx = new Uint32Array(numFaces * 3);
const ia = new decoderModule.DracoInt32Array();
for (let i = 0; i < numFaces; i++) {
  decoder.GetFaceFromMesh(mesh, i, ia);
  idx[i * 3] = ia.GetValue(0); idx[i * 3 + 1] = ia.GetValue(1); idx[i * 3 + 2] = ia.GetValue(2);
}
const readAttr = (id, comps) => {
  const attr = decoder.GetAttributeByUniqueId(mesh, id);
  const out = new decoderModule.DracoFloat32Array();
  decoder.GetAttributeFloatForAllPoints(mesh, attr, out);
  const a = new Float32Array(numPoints * comps);
  for (let i = 0; i < numPoints * comps; i++) a[i] = out.GetValue(i);
  decoderModule.destroy(out);
  return a;
};
const pos = readAttr(dracoExt.attributes.POSITION, 3);
const uv = dracoExt.attributes.TEXCOORD_0 !== undefined
  ? readAttr(dracoExt.attributes.TEXCOORD_0, 2) : null;

// Bounds, so we know what we are looking at.
let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
for (let i = 0; i < numPoints; i++) for (let k = 0; k < 3; k++) {
  mn[k] = Math.min(mn[k], pos[i * 3 + k]); mx[k] = Math.max(mx[k], pos[i * 3 + k]);
}
console.log('faces', numFaces, 'points', numPoints);
console.log('bounds min', mn.map(v => v.toFixed(3)).join(' '), 'max', mx.map(v => v.toFixed(3)).join(' '));
console.log('node', JSON.stringify(gltf.nodes[0]));
console.log('material', JSON.stringify(gltf.materials[0]));
console.log('images', JSON.stringify(gltf.images));
console.log('textures', JSON.stringify(gltf.textures));

fs.writeFileSync('geom.json', JSON.stringify({
  pos: Array.from(pos), uv: uv ? Array.from(uv) : null, idx: Array.from(idx),
}));
// Dump the textures too.
gltf.images.forEach((im, i) => {
  const v = im.bufferView !== undefined ? view(im.bufferView) : null;
  if (v) { fs.writeFileSync(`tex${i}.${im.mimeType.split('/')[1]}`, v); console.log('wrote tex' + i, im.mimeType, v.length); }
});
decoderModule.destroy(mesh); decoderModule.destroy(decoder); decoderModule.destroy(dracoBuf);
