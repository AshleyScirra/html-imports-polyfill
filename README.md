# HTML imports polyfill
This is a quick and dirty polyfill for HTML imports, used by [Construct 3](https://www.construct.net).

## Usage

Simply include htmlimports.js with a normal script tag.

`<script src="htmlimports.js"></script>`

The script adds three global functions. Note the polyfill makes no effort to read existing `<link rel="import">` tags; you must use the `addImport` method instead.

`addImport(url, async, progressObject)`

Load the HTML import at `url`. The `async` flag is only used if native HTML imports are supported, and sets the `async` attribute on the link element. `progressObject` has `loaded` and `total` properties written to it which can be checked periodically to determine loading progress. The function returns a promise that resolves when the import has finished loading.

`getImportDocument()`

Returns the current import document, for script included from an import.

`hasNativeHTMLImportsSupport()`

Returns true if native imports are supported.

## How it works

When HTML imports are natively supported, the functions simply wrap adding `<link rel="import">`. However when in polyfill mode, it works like this:

1. The import is fetched via XMLHttpRequest as a document.
2. Any stylesheets and scripts in the returned document are moved to the main document, so styles are applied and scripts are run.
3. Any further imports in the document are fetched and the process continues recursively.
4. `getImportDocument()` at the top level of any script included via an import is mapped to the document that included that script, allowing the script to access DOM content in its import.

Note that scripts and stylesheets are expected to be at the top level - they won't be loaded if they are nested in other tags.

The polyfill tries to load as much in parallel as possible, but only the browser has the necessary powers to load with optimal performance. In particular, the polyfill cannot even start fetching a script that comes after an import.

## Compatibility

The polyfill should work in any modern browser with ES6 support (the polyfill uses ES6 features).

The polyfill is robust enough to be a complete substitute for HTML imports in [Construct 3](https://www.construct.net), a complete game development IDE in a PWA.