// ============================================================================
// analyze-image — Supabase Edge Function
// ----------------------------------------------------------------------------
// Called once per vendor photo upload, AFTER the browser has already uploaded
// the file to Storage and inserted the item row with a quick client-computed
// analysis (so the listing is searchable immediately). This function re-runs
// the exact same colour + texture algorithm server-side against the actual
// stored file, then overwrites the row's dominant_hex/palette/texture with
// the authoritative result and flips analyzed_by to 'server'.
//
// Why both a client AND a server pass exist, rather than just one:
//   - Client-only would mean two vendors' identical photos could get slightly
//     different numbers depending on their phone's browser/canvas quirks, and
//     a vendor closing the tab mid-upload could leave a half-analyzed item.
//   - Server-only would mean every new listing sits unsearchable for the few
//     seconds it takes this function to run -- bad first impression for a
//     shopkeeper watching the screen.
//   - Both: instant + eventually authoritative. Same reasoning as the earlier
//     Python prototype's "colour extraction must survive an embedding
//     failure" rule -- degrade gracefully, never lose the listing.
//
// The maths below (CIELAB conversion, k-means palette, Sobel texture
// histogram) is a straight line-for-line port of the same functions in
// rangreza_version_3.html's client-side JS, verified byte-identical against
// it in validate_server_engine.js before this file was written. If you ever
// change the matching algorithm, change it in BOTH places.
//
// Deploy:
//   supabase functions deploy analyze-image --no-verify-jwt
// (See SETUP_GUIDE.md step 4 for the exact commands and required secrets.)
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Colour engine (ported from color science in the HTML app)
// ---------------------------------------------------------------------------

const D65 = [95.047, 100.0, 108.883];
const M_RGB2XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];

function srgbToLinear(c: number): number {
  c = c / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (M_RGB2XYZ[0][0] * R + M_RGB2XYZ[0][1] * G + M_RGB2XYZ[0][2] * B) * 100;
  const Y = (M_RGB2XYZ[1][0] * R + M_RGB2XYZ[1][1] * G + M_RGB2XYZ[1][2] * B) * 100;
  const Z = (M_RGB2XYZ[2][0] * R + M_RGB2XYZ[2][1] * G + M_RGB2XYZ[2][2] * B) * 100;
  const d = 6 / 29;
  const f = (t: number) => (t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29);
  const fx = f(X / D65[0]), fy = f(Y / D65[1]), fz = f(Z / D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a: number[], b: number[]): number {
  const dL = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

function rgbToHex(r: number, g: number, b: number): string {
  const p = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0").toUpperCase();
  return "#" + p(r) + p(g) + p(b);
}

function kmeansLab(pixels: number[][], k: number, iters = 12) {
  k = Math.max(1, Math.min(k, pixels.length));
  const cents: number[][] = [pixels[Math.floor(pixels.length / 2)]];
  for (let c = 1; c < k; c++) {
    let best: number[] | null = null, bestD = -1;
    const stride = Math.max(1, Math.floor(pixels.length / 220));
    for (let i = 0; i < pixels.length; i += stride) {
      let dmin = Infinity;
      for (const cc of cents) {
        const d = deltaE(pixels[i], cc);
        if (d < dmin) dmin = d;
      }
      if (dmin > bestD) { bestD = dmin; best = pixels[i]; }
    }
    cents.push(best || pixels[0]);
  }

  let labels = new Array(pixels.length).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let p = 0; p < pixels.length; p++) {
      let bi = 0, bd = Infinity;
      for (let q = 0; q < cents.length; q++) {
        const dd = deltaE(pixels[p], cents[q]);
        if (dd < bd) { bd = dd; bi = q; }
      }
      if (labels[p] !== bi) { labels[p] = bi; moved = true; }
    }
    if (!moved && it > 0) break;

    const sums = cents.map(() => [0, 0, 0, 0]);
    for (let s = 0; s < pixels.length; s++) {
      const L = labels[s], px = pixels[s];
      sums[L][0] += px[0]; sums[L][1] += px[1]; sums[L][2] += px[2]; sums[L][3]++;
    }
    for (let t = 0; t < cents.length; t++) {
      if (sums[t][3] > 0) {
        cents[t] = [sums[t][0] / sums[t][3], sums[t][1] / sums[t][3], sums[t][2] / sums[t][3]];
      }
    }
  }

  const counts = cents.map(() => 0);
  labels.forEach((L) => counts[L]++);
  return { cents, counts };
}

/** Dominant-colour palette from a decoded RGBA bitmap. Same rules as the
 * browser version: drop near-white/near-black pixels (bazaar photos are shot
 * on white sheets), fall back to raw pixels if that removes almost everything
 * (genuinely white lace, black velvet). */
function extractPalette(bitmap: Uint8ClampedArray | Uint8Array, k = 4) {
  const kept: number[][] = [], all: number[][] = [];
  for (let i = 0; i < bitmap.length; i += 4) {
    const r = bitmap[i], g = bitmap[i + 1], b = bitmap[i + 2], a = bitmap[i + 3];
    if (a < 128) continue;
    all.push([r, g, b]);
    const nearWhite = r > 235 && g > 235 && b > 235;
    const nearBlack = r < 22 && g < 22 && b < 22;
    if (!nearWhite && !nearBlack) kept.push([r, g, b]);
  }
  const use = kept.length >= Math.max(24, all.length * 0.05) ? kept : all;
  if (!use.length) return [{ hex: "#C9A24B", prop: 1 }];

  const labs = use.map((c) => rgbToLab(c[0], c[1], c[2]));
  const res = kmeansLab(labs, k);
  const total = res.counts.reduce((a, b) => a + b, 0) || 1;

  const out: { hex: string; prop: number }[] = [];
  for (let ci = 0; ci < res.cents.length; ci++) {
    if (res.counts[ci] === 0) continue;
    let bi = 0, bd = Infinity;
    for (let pi = 0; pi < labs.length; pi++) {
      const d = deltaE(labs[pi], res.cents[ci]);
      if (d < bd) { bd = d; bi = pi; }
    }
    out.push({ hex: rgbToHex(use[bi][0], use[bi][1], use[bi][2]), prop: res.counts[ci] / total });
  }
  out.sort((a, b) => b.prop - a.prop);
  return out.length ? out : [{ hex: "#C9A24B", prop: 1 }];
}

// ---------------------------------------------------------------------------
// Texture engine (ported from the HTML app's mini-HOG descriptor)
// ---------------------------------------------------------------------------

const TEX_BINS = 12;
const TEX_DIM = TEX_BINS * 2 + 2;

function greyscale(bitmap: Uint8ClampedArray | Uint8Array): Float32Array {
  const g = new Float32Array(bitmap.length / 4);
  for (let i = 0, p = 0; i < bitmap.length; i += 4, p++) {
    g[p] = (0.299 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.114 * bitmap[i + 2]) / 255;
  }
  return g;
}

/** Nearest-neighbour resize -- adequate for a histogram descriptor; we are not
 * pixel-diffing, just summarising edge orientation at two scales. */
function resizeGrey(grey: Float32Array, w: number, h: number, size: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / size));
      const sy = Math.min(h - 1, Math.floor((y * h) / size));
      out[y * size + x] = grey[sy * w + sx];
    }
  }
  return out;
}

function orientationHist(grey: Float32Array, size: number) {
  const hist = new Float32Array(TEX_BINS);
  let edgeSum = 0, n = 0, mean = 0, m2 = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const gx =
        grey[i - size + 1] + 2 * grey[i + 1] + grey[i + size + 1] -
        (grey[i - size - 1] + 2 * grey[i - 1] + grey[i + size - 1]);
      const gy =
        grey[i + size - 1] + 2 * grey[i + size] + grey[i + size + 1] -
        (grey[i - size - 1] + 2 * grey[i - size] + grey[i - size + 1]);
      const mag = Math.sqrt(gx * gx + gy * gy);
      let ang = Math.atan2(gy, gx);
      if (ang < 0) ang += Math.PI;
      const bin = Math.min(TEX_BINS - 1, Math.floor((ang / Math.PI) * TEX_BINS));
      hist[bin] += mag;
      edgeSum += mag; n++;
      const delta = grey[i] - mean;
      mean += delta / n;
      m2 += delta * (grey[i] - mean);
    }
  }
  return { hist, density: n ? edgeSum / n : 0, contrast: n ? Math.sqrt(m2 / n) : 0 };
}

function textureDescriptor(bitmap: Uint8ClampedArray | Uint8Array, w: number, h: number): number[] {
  const grey = greyscale(bitmap);
  const fine = resizeGrey(grey, w, h, 64);
  const coarse = resizeGrey(grey, w, h, 32);
  const a = orientationHist(fine, 64);
  const b = orientationHist(coarse, 32);

  const v = new Float32Array(TEX_DIM);
  let k = 0;
  for (let i = 0; i < TEX_BINS; i++) v[k++] = a.hist[i];
  for (let i = 0; i < TEX_BINS; i++) v[k++] = b.hist[i];
  v[k++] = a.density * 8;
  v[k++] = a.contrast * 8;

  let norm = 0;
  for (let i = 0; i < TEX_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1e-9;
  for (let i = 0; i < TEX_DIM; i++) v[i] /= norm;

  return Array.from(v);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  // Service-role key so this function can (a) verify the caller's own JWT and
  // (b) write the analysis result even though the row's RLS update policy is
  // scoped to the owning vendor -- this function is the one legitimate
  // exception, acting on the vendor's behalf right after their own upload.
  const SERVICE_KEY = Deno.env.get("SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SERVICE_KEY secret");
    return json({ error: "Server misconfigured" }, 500);
  }

  // Verify the caller is a real signed-in user (any role) before doing any
  // work. This function is invoked by the browser right after an authenticated
  // upload, so a missing/invalid token means something is wrong upstream.
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return json({ error: "Invalid or expired session" }, 401);
  }

  let body: { item_id?: string; image_path?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  const { item_id, image_path } = body;
  if (!item_id || !image_path) {
    return json({ error: "item_id and image_path are required" }, 400);
  }

  // Ownership check: the caller must actually be the vendor who owns this
  // item, even though we're using the service-role client to do the write.
  // Without this, any signed-in user could pass an arbitrary item_id and
  // trigger a write to someone else's listing.
  const { data: item, error: itemErr } = await admin
    .from("inventory_items")
    .select("id, vendor_id, vendors!inner(user_id)")
    .eq("id", item_id)
    .single();

  if (itemErr || !item) return json({ error: "Item not found" }, 404);
  // deno-lint-ignore no-explicit-any
  const ownerId = (item as any).vendors?.user_id;
  if (ownerId !== userData.user.id) {
    return json({ error: "You do not own this item" }, 403);
  }

  // Download the actual stored file and decode it -- this is the point of the
  // whole function: analyse the REAL bytes that live in Storage, not whatever
  // the uploading browser happened to compute.
  const { data: fileBlob, error: dlErr } = await admin.storage
    .from("vendor-photos")
    .download(image_path);

  if (dlErr || !fileBlob) {
    console.error("Storage download failed:", dlErr);
    return json({ error: "Could not read the uploaded photo" }, 500);
  }

  let img;
  try {
    const bytes = new Uint8Array(await fileBlob.arrayBuffer());
    img = await Image.decode(bytes);
  } catch (e) {
    console.error("Image decode failed:", e);
    return json({ error: "That file could not be decoded as an image" }, 400);
  }

  // Downscale before analysis -- a 4000px phone photo tells the algorithm
  // nothing a 256px version doesn't, and it's much faster to process.
  if (img.width > 256 || img.height > 256) {
    img = img.resize(256, Image.RESIZE_AUTO);
  }

  const bitmap = img.bitmap as Uint8Array;
  const palette = extractPalette(bitmap, 4);
  const texture = textureDescriptor(bitmap, img.width, img.height);
  const dominant_hex = palette[0].hex;

  const { error: updateErr } = await admin
    .from("inventory_items")
    .update({
      dominant_hex,
      palette,
      texture,
      analyzed_by: "server",
    })
    .eq("id", item_id);

  if (updateErr) {
    console.error("Failed to save analysis:", updateErr);
    return json({ error: "Analysed but failed to save" }, 500);
  }

  return json({ ok: true, item_id, dominant_hex, palette, analyzed_by: "server" });
});
