// Side-effect module: registers the pubid identifier types the slug
// resolver (relaton#441) decodes slugs into. Each import is one flavor's
// model module - declarative attribute tables plus the pure-TS parslet
// engine; no filesystem access, so the whole set is worker-safe.
//
// Three flavors are deliberately absent: `nist` and `ieee` statically
// import the parg runtime, which walks up to a package.json at import
// time (node:fs) - impossible in a worker bundle; `oiml` ships no flavor
// index at all, and its publisher-restore lives behind the full barrel
// (model-only registration degrades its render). Slugs of those three
// answer 404 until pubid-ts splits the model registration out of the
// grammar wiring.
import "@pubid/pubid/dist/flavors/amca/index.js";
import "@pubid/pubid/dist/flavors/ansi/index.js";
import "@pubid/pubid/dist/flavors/api/index.js";
import "@pubid/pubid/dist/flavors/ashrae/index.js";
import "@pubid/pubid/dist/flavors/asme/index.js";
import "@pubid/pubid/dist/flavors/astm/index.js";
import "@pubid/pubid/dist/flavors/bipm/index.js";
import "@pubid/pubid/dist/flavors/bsi/index.js";
import "@pubid/pubid/dist/flavors/calconnect/index.js";
import "@pubid/pubid/dist/flavors/cen_cenelec/index.js";
import "@pubid/pubid/dist/flavors/cie/index.js";
import "@pubid/pubid/dist/flavors/csa/index.js";
import "@pubid/pubid/dist/flavors/doi/index.js";
import "@pubid/pubid/dist/flavors/easc/index.js";
import "@pubid/pubid/dist/flavors/ecma/index.js";
import "@pubid/pubid/dist/flavors/etsi/index.js";
import "@pubid/pubid/dist/flavors/evs/index.js";
import "@pubid/pubid/dist/flavors/gb/index.js";
import "@pubid/pubid/dist/flavors/gost/index.js";
import "@pubid/pubid/dist/flavors/iala/index.js";
import "@pubid/pubid/dist/flavors/iana/index.js";
import "@pubid/pubid/dist/flavors/idf/index.js";
import "@pubid/pubid/dist/flavors/iec/index.js";
import "@pubid/pubid/dist/flavors/ietf/index.js";
import "@pubid/pubid/dist/flavors/iho/index.js";
import "@pubid/pubid/dist/flavors/isbn/index.js";
import "@pubid/pubid/dist/flavors/iso/index.js";
import "@pubid/pubid/dist/flavors/itu/index.js";
import "@pubid/pubid/dist/flavors/jcgm/index.js";
import "@pubid/pubid/dist/flavors/jis/index.js";
import "@pubid/pubid/dist/flavors/oasis/index.js";
import "@pubid/pubid/dist/flavors/ogc/index.js";
import "@pubid/pubid/dist/flavors/omg/index.js";
import "@pubid/pubid/dist/flavors/plateau/index.js";
import "@pubid/pubid/dist/flavors/tgpp/index.js";
import "@pubid/pubid/dist/flavors/un/index.js";
import "@pubid/pubid/dist/flavors/w3c/index.js";
import "@pubid/pubid/dist/flavors/xsf/index.js";
