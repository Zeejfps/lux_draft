/**
 * The eager module barrel, imported for its registration side effect exactly as `main.ts`
 * does. A document's module slices are normalized against the installed-module table, so a
 * test that builds or opens a document before anything registered would get a document with
 * no lighting slice and silently no-op every `lighting.*` command.
 */
import '../src/modules/codecs';
