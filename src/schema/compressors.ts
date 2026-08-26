import { decompress } from 'fzstd';
import type { Compressors } from 'hyparquet';

/**
 * The one codec worth carrying a dependency for.
 *
 * hyparquet decodes snappy and stores uncompressed pages as they are, which
 * covers footers — those are never compressed — but not pages. polars writes
 * parquet with zstd unless told otherwise, so without this the two places that
 * do decompress a page would both go quiet on a file polars had just written:
 * value completion, and a Delta table read from its checkpoint.
 *
 * fzstd is decompression only, in plain JavaScript, with no dependencies of its
 * own. Brotli, gzip and LZ4 are still not decoded — they are rare enough in
 * parquet that a second dependency is not worth the weight, and staying quiet
 * remains the answer when a page cannot be read.
 */
export const COMPRESSORS: Compressors = {
  ZSTD: (input: Uint8Array, outputLength: number): Uint8Array => {
    const out = decompress(input);
    // hyparquet asks for an exact size; a frame that decodes to more than the
    // page claims is a broken file, and one that decodes to less is handed back
    // as it is rather than padded with zeroes that would read as data.
    return out.length > outputLength ? out.subarray(0, outputLength) : out;
  }
};
