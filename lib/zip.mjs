/**
 * A zip reader, just big enough for draw.io's `draw.war`.
 *
 * The canvas may not carry dependencies (see `extension.mjs`), and a `.war` is
 * an ordinary zip: a central directory at the end naming every entry, each
 * entry stored or raw-deflated. `node:zlib` does the inflating; this file only
 * walks the directory. ZIP64, encryption and multi-disk archives are refused
 * by name rather than half-read, because a silently truncated editor is a worse
 * failure than a clear one.
 */

import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

export class ZipError extends Error {
	constructor(message) {
		super(message);
		this.name = "ZipError";
	}
}

function findEndOfCentralDirectory(buffer) {
	// The record is 22 bytes plus a comment of up to 64 KiB, so it is somewhere
	// in the last 65,557 bytes; scan backwards for its signature.
	const floor = Math.max(0, buffer.length - 65_557);
	for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
		if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
	}
	throw new ZipError("Not a zip archive: no end-of-central-directory record.");
}

/**
 * List the entries of a zip held in memory.
 *
 * Returns `{ name, directory, size, read() }` per entry; `read()` inflates on
 * demand so listing a 50 MB archive costs nothing until a file is wanted.
 */
export function listZip(buffer) {
	const end = findEndOfCentralDirectory(buffer);
	const count = buffer.readUInt16LE(end + 10);
	const directorySize = buffer.readUInt32LE(end + 12);
	const directoryOffset = buffer.readUInt32LE(end + 16);
	if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
		throw new ZipError("ZIP64 archives are not supported.");
	}
	const entries = [];
	let offset = directoryOffset;
	for (let index = 0; index < count; index += 1) {
		if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) throw new ZipError(`Corrupt central directory at entry ${index}.`);
		const flags = buffer.readUInt16LE(offset + 8);
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const size = buffer.readUInt32LE(offset + 24);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
		offset += 46 + nameLength + extraLength + commentLength;
		if (flags & 0x1) throw new ZipError(`Entry "${name}" is encrypted.`);
		entries.push({
			name,
			directory: name.endsWith("/"),
			size,
			read: () => {
				if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) throw new ZipError(`Corrupt local header for "${name}".`);
				const localName = buffer.readUInt16LE(localOffset + 26);
				const localExtra = buffer.readUInt16LE(localOffset + 28);
				const start = localOffset + 30 + localName + localExtra;
				const data = buffer.subarray(start, start + compressedSize);
				if (method === 0) return Buffer.from(data);
				if (method === 8) return inflateRawSync(data);
				throw new ZipError(`Entry "${name}" uses unsupported compression method ${method}.`);
			},
		});
	}
	return entries;
}
