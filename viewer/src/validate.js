/**
 * Device validation: the checks a DJ cannot run any other way.
 *
 * rekordbox tells you something is wrong with a device once you have already
 * carried it to the booth -- a track that will not load, a waveform that never
 * draws, a warning naming a count and no filenames. Everything needed to say
 * *which* track is on the stick already; this reads it and names names.
 *
 * Three checks, in the order they cost:
 *
 *   library    the two libraries on a converted device disagree
 *   files      a track's audio or analysis file is not where the database says
 *   cues       a track has lost the cues the database says it recorded
 *
 * What a track *has* is not a fault and is not reported here. How many cues it
 * carries and which tags are on it are attributes of the track, so they belong
 * in the track list beside its key and its rating, where they can be read down
 * a column and sorted by eye. A finding is for what a DJ has to act on. The cue
 * counts this run gathers are returned for that column rather than flagged.
 *
 * Two design rules hold throughout.
 *
 * **It never throws.** A validator that falls over on the one device that
 * needed validating is worse than none, and it runs over data that is by
 * definition suspect. Every per-track step is caught individually: a track
 * that cannot be checked becomes a finding of its own and the run continues.
 * The worst outcome is an incomplete report, never a broken page.
 *
 * **It reads nothing it does not need.** Counting cues needs the `PCOB`
 * sections of the `.DAT` and nothing else, so the `.EXT` -- which is most of
 * the bytes on a device, being colour waveforms -- is never opened, and the
 * `.DAT` is tallied rather than decoded. Even so this is the only part of the
 * viewer that touches every file on the stick, so it runs on demand rather than
 * at load, reports progress, and can be cancelled.
 *
 * The module is deliberately free of both the DOM and the database: it takes
 * plain rows and a file map, so it can be tested in node.
 */

import { parseSections, countCues } from './anlz.js';
import { deviceFileIndex, devicePath } from './devicefiles.js';

/**
 * The rules, and what each one means.
 *
 * `severity` is about consequence in the booth, not about certainty:
 *
 *   error  the track will not play, or will play wrong
 *   warn   the track plays, but something you prepared is not there
 *   info   worth knowing; not a fault
 *
 * `hint` is shown with the finding, because "12 tracks are missing their audio"
 * is only useful next to what that costs you.
 */
export const RULES = {
  noPath: {
    severity: 'error',
    title: 'No file path recorded',
    hint: 'The database has the track but not where its audio lives. It cannot load.',
  },
  fileMissing: {
    severity: 'error',
    title: 'Audio file missing',
    hint: 'The database points at a file that is not on this device. The track '
        + 'appears in the browser and fails when you load it.',
  },
  fileChanged: {
    severity: 'warn',
    title: 'Audio file replaced since export',
    hint: 'The file is there but is not the size the database recorded — it was '
        + 're-encoded or re-tagged after export. Cues and the beatgrid were '
        + 'measured against the old file and may no longer line up.',
  },
  analysisMissing: {
    severity: 'warn',
    title: 'No analysis file',
    hint: 'The ANLZ file is missing, so the track has no waveform, no beatgrid '
        + 'and no cues on the player. It still plays.',
  },
  cuesLost: {
    severity: 'error',
    title: 'Cues recorded, but the analysis file has none',
    hint: 'The database counts cue edits on this track and the ANLZ file holds '
        + 'no cues at all. The analysis file is stale or was overwritten — the '
        + 'cues are gone from the device.',
  },
  onlyInOneLibrary: {
    severity: 'warn',
    title: 'Missing from the legacy library',
    hint: 'On this track the two libraries disagree. Players that read '
        + 'OneLibrary see it; older players, which read export.pdb, do not.',
  },
  onlyInLegacy: {
    severity: 'warn',
    title: 'Missing from the OneLibrary library',
    hint: 'Only the legacy export.pdb has this track, and OneLibrary wins on '
        + 'any player that understands it. Re-run the conversion in rekordbox.',
  },
  unreadable: {
    severity: 'warn',
    title: 'Could not be checked',
    hint: 'Something about this track stopped the check part-way. The rest of '
        + 'the report is unaffected.',
  },
};

/**
 * A rule that describes a failure of the check itself rather than of the
 * device, so it is never reported as having passed: "Passed: Could not be
 * checked" reads as a result when it is the absence of one.
 */
const NOT_A_CHECK = new Set(['unreadable']);

/** Worst first, which is also the order a DJ wants to read them in. */
const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

/**
 * How many tracks a rule names before the rest are counted rather than kept.
 *
 * A rule can fire on most of a library -- move the audio folder and every
 * track on the stick is missing -- and no interface lists thousands of rows, so
 * keeping them would be retaining megabytes to display a hundred. The count
 * stays exact.
 */
export const MAX_NAMED = 100;

/** Files opened at once. Small reads on a stick are latency-bound, not bandwidth-bound. */
const READ_CONCURRENCY = 8;

/** How long to hold the thread before handing it back to the page, in ms. */
const YIELD_EVERY_MS = 50;

/**
 * Give the page a turn.
 *
 * `scheduler.yield` resumes at the front of the queue where it exists; the
 * fallback is a timer, which browsers clamp to ~4ms once nested, so the
 * caller yields on a time budget rather than on a count to keep that rare.
 */
const yieldToPage = () =>
  globalThis.scheduler?.yield?.() ?? new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Compare the two libraries a converted device carries.
 *
 * The obvious question -- "when was this last synced?" -- has no honest answer
 * from the data. `property.createdDate` dates the OneLibrary export, but the
 * legacy PDB records no export date at all, and a file's timestamp is rewritten
 * by any copy. What *is* answerable exactly is whether the two agree, which is
 * the question underneath: rekordbox writes OneLibrary alongside export.pdb and
 * never removes it, OneLibrary wins on players that understand it, and older
 * players read the other one. A device whose two libraries have drifted plays
 * differently depending on which CDJ it is plugged into, and nothing says so.
 */
function checkLibraries(add, tracks, legacyTracks) {
  const mine = new Map();
  for (const t of tracks) {
    const key = devicePath(t.path);
    if (key) mine.set(key, t);
  }
  const theirs = new Map();
  for (const t of legacyTracks) {
    const key = devicePath(t.path);
    if (key) theirs.set(key, t);
  }
  for (const [key, track] of mine) {
    if (!theirs.has(key)) add('onlyInOneLibrary', track, track.path);
  }
  // A legacy row's id belongs to the PDB's own id space, which has nothing to
  // do with the ids the page is showing. It is named, not identified, so that
  // no reader of the report can mistake it for a track it could select.
  for (const [key, track] of theirs) {
    if (!mine.has(key)) add('onlyInLegacy', { title: track.title }, track.path);
  }
}

/**
 * Check a device, and describe what is wrong with it.
 *
 * Everything is injected rather than read: the caller owns the database and the
 * dropped files, and passing plain rows keeps this module testable without
 * either. `legacyTracks` is null on a device that carries only one library,
 * which skips the comparison rather than failing it.
 *
 * @param {object} ctx
 * @param {object[]} ctx.tracks          `content` rows
 * @param {Map<string, File>} ctx.files  lowercase device-relative path -> File
 * @param {(p: string) => File|null} [ctx.find]  the page's own resolver, if it
 *   has already built one; otherwise an index is built over `files`
 * @param {object[]} [ctx.legacyTracks]  legacy `content` rows, or null
 * @param {(done: number, total: number) => void} [ctx.onProgress]
 * @param {{ cancelled?: boolean }} [ctx.signal]  set `cancelled` to stop early
 * @returns {Promise<object>} a report, and the cue counts it read on the way;
 *   never rejects
 */
export async function validate(ctx) {
  const {
    tracks = [],
    files = new Map(),
    find = deviceFileIndex(files),
    legacyTracks = null,
    onProgress,
    signal,
  } = ctx || {};

  /** rule -> { count, items }. `count` is exact; `items` stops at MAX_NAMED. */
  const groups = new Map();
  const add = (rule, track, note) => {
    let group = groups.get(rule);
    if (!group) groups.set(rule, (group = { count: 0, items: [] }));
    group.count += 1;
    if (group.items.length < MAX_NAMED) {
      group.items.push({
        content_id: track?.content_id ?? null,
        title: track?.title || '(untitled)',
        note: note || '',
      });
    }
  };

  // Rules a device cannot be judged against, so they are neither reported nor
  // claimed as passed. A library nobody tagged is not a library in which every
  // track is at fault, and a device with one library has nothing to compare.
  const skipped = new Set(NOT_A_CHECK);
  if (legacyTracks) checkLibraries(add, tracks, legacyTracks);
  else ['onlyInOneLibrary', 'onlyInLegacy'].forEach((r) => skipped.add(r));

  /**
   * Check one track. Findings are collected per track rather than appended
   * directly, so that reading files in parallel below cannot make the order of
   * a report depend on which disk read happened to finish first.
   */
  const checkTrack = async (track) => {
    const found = [];
    let cues = null;
    const collect = (rule, subject, note) => found.push([rule, subject, note]);
    try {
      if (!track.path) {
        collect('noPath', track);
      } else {
        const audio = find(track.path);
        if (!audio) {
          collect('fileMissing', track, track.path);
        } else if (track.fileSize && audio.size && audio.size !== track.fileSize) {
          const delta = audio.size - track.fileSize;
          collect('fileChanged', track,
                  `${delta > 0 ? '+' : ''}${delta.toLocaleString()} bytes`);
        }
      }

      // Cues live in the analysis file, so a missing one is reported as such
      // and the cue check is skipped rather than blamed for its absence.
      const dat = track.analysisDataFilePath ? find(track.analysisDataFilePath) : null;
      if (!dat) {
        collect('analysisMissing', track, track.analysisDataFilePath || 'none recorded');
      } else {
        // rekordbox does not populate the database's `cue` table on export --
        // a device whose tracks carry hot cues, memory cues and saved loops has
        // zero rows in it, and every one of those cues is in the ANLZ. A cue
        // checker written against the table would report every track on every
        // device as having no cues. `content.cueUpdateCount` is the only trace
        // the database keeps, so counting edits while the ANLZ holds nothing
        // means the two have come apart.
        const { total, memory } = countCues(parseSections(new Uint8Array(await dat.arrayBuffer())));
        cues = { memory, hot: total - memory };
        if (!total && Number(track.cueUpdateCount) > 0) {
          collect('cuesLost', track, `${track.cueUpdateCount} cue edits recorded`);
        }
      }
    } catch (err) {
      collect('unreadable', track, err?.message || String(err));
    }
    return { found, cues };
  };

  // Each track is one small read of a file that is probably not in any cache,
  // so a strictly sequential walk spends the whole run waiting on one open at a
  // time. A fixed pool draws from a shared cursor: enough reads in flight to
  // keep the device busy, and a bound so that a large library does not issue
  // ten thousand of them at once.
  const results = new Array(tracks.length);
  let next = 0;
  let checked = 0;
  let lastYield = performance.now();

  const worker = async () => {
    while (next < tracks.length && !signal?.cancelled) {
      const i = next++;
      results[i] = await checkTrack(tracks[i]);
      checked += 1;
      // Every file on the device passes through here, so the page has to be
      // handed back or a large library freezes it for the length of the run.
      if (performance.now() - lastYield > YIELD_EVERY_MS) {
        lastYield = performance.now();
        onProgress?.(checked, tracks.length);
        await yieldToPage();
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, tracks.length) }, worker)
  );
  onProgress?.(checked, tracks.length);

  /** content_id -> `{ memory, hot }`, for the track list's cue column. */
  const cues = new Map();
  for (const [i, result] of results.entries()) {
    if (!result) continue;
    for (const [rule, subject, note] of result.found) add(rule, subject, note);
    if (result.cues) cues.set(tracks[i].content_id, result.cues);
  }

  const findings = [...groups]
    .map(([rule, group]) => ({ rule, ...RULES[rule], ...group }))
    .sort((a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count);

  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] += f.count;

  return {
    findings,
    counts,
    // Naming what was checked and found clean is what separates a validator
    // that found no problems from one that never ran.
    passed: Object.keys(RULES)
      .filter((rule) => !skipped.has(rule) && !groups.has(rule))
      .map((rule) => RULES[rule].title),
    cues,
    trackCount: tracks.length,
    checkedCount: checked,
    cancelled: Boolean(signal?.cancelled),
  };
}
