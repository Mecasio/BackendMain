/**
 * pdfMerge.js
 *
 * Minimal, dependency-free PDF combiner for merging multiple
 * Chromium/Puppeteer-generated PDFs (page.pdf() output) into a single
 * PDF document.
 *
 * This is intentionally NOT a general-purpose PDF library. It assumes:
 *   - Each input PDF is a single-revision document with a classic
 *     (uncompressed) cross-reference table ("xref" ... "trailer").
 *   - No encryption, no linearization, no object streams / xref streams.
 *   - Object dictionaries are ASCII and small enough to scan directly;
 *     only `stream ... endstream` payloads may contain arbitrary binary
 *     data, and those bytes are never touched or re-scanned.
 *
 * These assumptions hold for Puppeteer's page.pdf() output as produced by
 * Chromium's built-in PDF printer. If Chromium's output format changes in
 * a way this module doesn't understand, parsePdf() will throw a clear
 * error instead of silently producing a corrupt file.
 */

const PDF_HEADER = "%PDF-1.4\n";

// ---------------------------------------------------------------------
// Low-level parsing helpers
// ---------------------------------------------------------------------

function parseStartXref(buffer) {
  const idx = buffer.lastIndexOf("startxref", buffer.length, "latin1");
  if (idx === -1) throw new Error("pdfMerge: 'startxref' not found");
  const tail = buffer.toString("latin1", idx + "startxref".length);
  const match = tail.match(/\s*(\d+)/);
  if (!match) throw new Error("pdfMerge: malformed startxref value");
  return parseInt(match[1], 10);
}

function findMatchingDictEnd(text, startPos) {
  if (text.slice(startPos, startPos + 2) !== "<<") {
    throw new Error("pdfMerge: expected '<<' at dictionary start");
  }
  let depth = 0;
  let i = startPos;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "<<") {
      depth += 1;
      i += 2;
    } else if (two === ">>") {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  throw new Error("pdfMerge: unterminated dictionary");
}

function parseXrefTable(buffer, xrefOffset) {
  const text = buffer.toString("latin1", xrefOffset);
  if (!text.startsWith("xref")) {
    throw new Error(
      "pdfMerge: only classic (non cross-reference-stream) xref tables are supported",
    );
  }

  let pos = 4; // past "xref"
  const entries = new Map(); // objNum -> { offset, inUse }

  const skipWs = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
  };

  for (;;) {
    skipWs();
    if (text.startsWith("trailer", pos)) break;

    const header = text.slice(pos).match(/^(\d+)\s+(\d+)\s*[\r\n]+/);
    if (!header) {
      throw new Error("pdfMerge: malformed xref subsection header");
    }
    const startNum = parseInt(header[1], 10);
    const count = parseInt(header[2], 10);
    pos += header[0].length;

    for (let i = 0; i < count; i += 1) {
      const line = text.slice(pos, pos + 20);
      const m = line.match(/^(\d{10})\s(\d{5})\s([nf])/);
      if (!m) throw new Error("pdfMerge: malformed xref entry");
      entries.set(startNum + i, {
        offset: parseInt(m[1], 10),
        inUse: m[3] === "n",
      });
      pos += 20;
    }
  }

  skipWs();
  if (!text.startsWith("trailer", pos)) {
    throw new Error("pdfMerge: 'trailer' keyword not found after xref table");
  }
  pos += "trailer".length;
  skipWs();

  const dictEnd = findMatchingDictEnd(text, pos);
  const trailerDictText = text.slice(pos, dictEnd);

  return { entries, trailerDictText };
}

function extractRef(dictText, key) {
  const re = new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`);
  const m = dictText.match(re);
  return m ? { num: parseInt(m[1], 10), gen: parseInt(m[2], 10) } : null;
}

function extractInt(dictText, key) {
  // Matches a literal integer value, but NOT the first number of an
  // indirect reference like "/Length 12 0 R".
  const re = new RegExp(`/${key}\\s+(\\d+)(?!\\s+\\d+\\s+R)`);
  const m = dictText.match(re);
  return m ? parseInt(m[1], 10) : null;
}

function extractName(dictText, key) {
  const re = new RegExp(`/${key}\\s*/(\\w+)`);
  const m = dictText.match(re);
  return m ? m[1] : null;
}

function extractRefArray(dictText, key) {
  const re = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`);
  const m = dictText.match(re);
  if (!m) return [];
  const refs = [];
  const refRe = /(\d+)\s+(\d+)\s+R/g;
  let rm;
  // eslint-disable-next-line no-cond-assign
  while ((rm = refRe.exec(m[1]))) {
    refs.push({ num: parseInt(rm[1], 10), gen: parseInt(rm[2], 10) });
  }
  return refs;
}

const DICT_SCAN_WINDOW = 50000; // bytes; generous headroom for object dicts

function extractObject(buffer, offset) {
  const headerText = buffer.toString(
    "latin1",
    offset,
    Math.min(offset + 40, buffer.length),
  );
  const headerMatch = headerText.match(/^(\d+)\s+(\d+)\s+obj\s*/);
  if (!headerMatch) {
    throw new Error(`pdfMerge: invalid object header at offset ${offset}`);
  }
  const objNum = parseInt(headerMatch[1], 10);
  const bodyStart = offset + headerMatch[0].length;

  const scanWindow = buffer.toString(
    "latin1",
    bodyStart,
    Math.min(bodyStart + DICT_SCAN_WINDOW, buffer.length),
  );

  let dictEnd = 0;
  let dictText = "";
  if (scanWindow.startsWith("<<")) {
    dictEnd = findMatchingDictEnd(scanWindow, 0);
    dictText = scanWindow.slice(0, dictEnd);
  }

  const afterDict = scanWindow.slice(dictEnd);
  const streamMatch = afterDict.match(/^\s*stream\r?\n/);

  if (streamMatch) {
    const streamDataStart = bodyStart + dictEnd + streamMatch[0].length;
    const declaredLength = extractInt(dictText, "Length");

    let streamDataEnd;
    if (declaredLength != null) {
      streamDataEnd = streamDataStart + declaredLength;
    } else {
      // /Length was indirect or missing — fall back to scanning for the
      // literal "endstream" marker (only ever used as a last resort).
      const idx = buffer.indexOf("endstream", streamDataStart, "latin1");
      if (idx === -1) {
        throw new Error(`pdfMerge: 'endstream' not found for object ${objNum}`);
      }
      streamDataEnd = idx;
      while (
        streamDataEnd > streamDataStart &&
        (buffer[streamDataEnd - 1] === 0x0a || buffer[streamDataEnd - 1] === 0x0d)
      ) {
        streamDataEnd -= 1;
      }
    }

    const streamBytes = buffer.slice(streamDataStart, streamDataEnd);
    return { objNum, dictText, streamBytes, hasStream: true };
  }

  const endObjIdx = buffer.indexOf("endobj", bodyStart, "latin1");
  if (endObjIdx === -1) {
    throw new Error(`pdfMerge: 'endobj' not found for object ${objNum}`);
  }
  const bodyText = buffer
    .toString("latin1", bodyStart, endObjIdx)
    .replace(/\s+$/, "");

  return { objNum, dictText: bodyText, streamBytes: null, hasStream: false };
}

// ---------------------------------------------------------------------
// Per-document parsing
// ---------------------------------------------------------------------

function parsePdf(buffer) {
  const xrefOffset = parseStartXref(buffer);
  const { entries, trailerDictText } = parseXrefTable(buffer, xrefOffset);

  const objects = new Map();
  for (const [objNum, { offset, inUse }] of entries) {
    if (!inUse || objNum === 0) continue;
    objects.set(objNum, extractObject(buffer, offset));
  }

  const rootRef = extractRef(trailerDictText, "Root");
  if (!rootRef) throw new Error("pdfMerge: trailer missing /Root");
  const rootObj = objects.get(rootRef.num);
  if (!rootObj) throw new Error("pdfMerge: /Root object not found");

  const pagesRef = extractRef(rootObj.dictText, "Pages");
  if (!pagesRef) throw new Error("pdfMerge: /Catalog missing /Pages");

  const pageNums = [];
  const visit = (ref) => {
    const node = objects.get(ref.num);
    if (!node) return;
    const type = extractName(node.dictText, "Type");
    if (type === "Page") {
      pageNums.push(ref.num);
      return;
    }
    for (const kid of extractRefArray(node.dictText, "Kids")) visit(kid);
  };
  visit(pagesRef);

  if (pageNums.length === 0) {
    throw new Error("pdfMerge: no pages found in source PDF");
  }

  return { objects, pageNums };
}

// ---------------------------------------------------------------------
// Merge + serialize
// ---------------------------------------------------------------------

function buildPdfBuffer(objects, rootObjNum) {
  const chunks = [Buffer.from(PDF_HEADER, "latin1")];
  let offset = chunks[0].length;

  const nums = [...objects.keys()].sort((a, b) => a - b);
  const maxNum = nums[nums.length - 1];
  const offsets = new Map();

  for (const num of nums) {
    const obj = objects.get(num);
    offsets.set(num, offset);

    const header = Buffer.from(`${num} 0 obj\n${obj.dictText}\n`, "latin1");
    chunks.push(header);
    offset += header.length;

    if (obj.hasStream) {
      const streamHeader = Buffer.from("stream\n", "latin1");
      chunks.push(streamHeader);
      offset += streamHeader.length;

      chunks.push(obj.streamBytes);
      offset += obj.streamBytes.length;

      const streamFooter = Buffer.from("\nendstream\nendobj\n", "latin1");
      chunks.push(streamFooter);
      offset += streamFooter.length;
    } else {
      const footer = Buffer.from("endobj\n", "latin1");
      chunks.push(footer);
      offset += footer.length;
    }
  }

  const xrefOffset = offset;
  const lines = [`xref`, `0 ${maxNum + 1}`, `0000000000 65535 f `];
  for (let num = 1; num <= maxNum; num += 1) {
    const objOffset = offsets.get(num);
    lines.push(
      objOffset != null
        ? `${String(objOffset).padStart(10, "0")} 00000 n `
        : `0000000000 00000 f `,
    );
  }
  chunks.push(Buffer.from(`${lines.join("\n")}\n`, "latin1"));

  const trailer =
    `trailer\n<< /Size ${maxNum + 1} /Root ${rootObjNum} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, "latin1"));

  return Buffer.concat(chunks);
}

/**
 * Merge an array of PDF Buffers (each a full, standalone PDF file) into a
 * single PDF Buffer, concatenating their pages in order.
 *
 * If only one buffer is given, it is returned unmodified.
 */
function mergePdfBuffers(pdfBuffers) {
  if (!Array.isArray(pdfBuffers) || pdfBuffers.length === 0) {
    throw new Error("pdfMerge: mergePdfBuffers requires at least one PDF buffer");
  }
  if (pdfBuffers.length === 1) {
    return pdfBuffers[0];
  }

  const mergedObjects = new Map();
  const mergedPageRefs = [];
  let nextObjNum = 1;

  for (const buffer of pdfBuffers) {
    const { objects, pageNums } = parsePdf(buffer);

    const remap = new Map();
    const sortedNums = [...objects.keys()].sort((a, b) => a - b);
    for (const oldNum of sortedNums) {
      remap.set(oldNum, nextObjNum);
      nextObjNum += 1;
    }

    const rewriteRefs = (text) =>
      text.replace(/(\d+)\s+(\d+)\s+R\b/g, (whole, num) => {
        const newNum = remap.get(parseInt(num, 10));
        return newNum == null ? whole : `${newNum} 0 R`;
      });

    for (const oldNum of sortedNums) {
      const obj = objects.get(oldNum);
      mergedObjects.set(remap.get(oldNum), {
        dictText: rewriteRefs(obj.dictText),
        streamBytes: obj.streamBytes,
        hasStream: obj.hasStream,
      });
    }

    for (const oldPageNum of pageNums) {
      mergedPageRefs.push(remap.get(oldPageNum));
    }
  }

  const pagesObjNum = nextObjNum;
  nextObjNum += 1;
  const rootObjNum = nextObjNum;
  nextObjNum += 1;

  for (const pageNum of mergedPageRefs) {
    const page = mergedObjects.get(pageNum);
    if (/\/Parent\s+\d+\s+\d+\s+R/.test(page.dictText)) {
      page.dictText = page.dictText.replace(
        /\/Parent\s+\d+\s+\d+\s+R/,
        `/Parent ${pagesObjNum} 0 R`,
      );
    } else {
      page.dictText = page.dictText.replace("<<", `<< /Parent ${pagesObjNum} 0 R`);
    }
  }

  const kids = mergedPageRefs.map((n) => `${n} 0 R`).join(" ");
  mergedObjects.set(pagesObjNum, {
    dictText: `<< /Type /Pages /Kids [ ${kids} ] /Count ${mergedPageRefs.length} >>`,
    streamBytes: null,
    hasStream: false,
  });
  mergedObjects.set(rootObjNum, {
    dictText: `<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`,
    streamBytes: null,
    hasStream: false,
  });

  return buildPdfBuffer(mergedObjects, rootObjNum);
}

module.exports = { mergePdfBuffers, parsePdf };
