"use strict";

{
	// Map a script URL to its import document for GetImportDocument()
	const scriptUrlToImportDoc = new Map();

	function GetPathFromURL(url)
	{
		if (!url.length)
			return url;		// empty string
		
		const lastCh = url.charAt(url.length - 1);
		if (lastCh === "/" || lastCh === "\\")
			return url;		// already a path terminated by slash
		
		let last_slash = url.lastIndexOf("/");
		
		if (last_slash === -1)
			last_slash = url.lastIndexOf("\\");
		
		if (last_slash === -1)
			return "";			// neither slash found, assume no path (e.g. "file.ext" returns "" as path)
		
		return url.substr(0, last_slash + 1);
	};

	function FetchAs(url, responseType)
	{
		return new Promise((resolve, reject) =>
		{
			const xhr = new XMLHttpRequest();
			xhr.onload = (() =>
			{
				if (xhr.status >= 200 && xhr.status < 300)
				{
					resolve(xhr.response);
				}
				else
				{
					reject(new Error("Failed to fetch '" + url + "': " + xhr.status + " " + xhr.statusText));
				}
			});
			xhr.onerror = reject;

			xhr.open("GET", url);
			xhr.responseType = responseType;
			xhr.send();
		});
	}

	function AddScriptTag(url)
	{
		return new Promise((resolve, reject) =>
		{
			let elem = document.createElement("script");
			elem.onload = resolve;
			elem.onerror = reject;
			elem.async = false;		// preserve execution order
			elem.src = url;
			document.head.appendChild(elem);
		});
	}

	function AddStylesheet(url)
	{
		return new Promise((resolve, reject) =>
		{
			let elem = document.createElement("link");
			elem.onload = resolve;
			elem.onerror = reject;
			elem.rel = "stylesheet";
			elem.href = url;
			document.head.appendChild(elem);
		});
	}

	// Look through a parent element's children for relevant nodes (imports, style, script)
	function FindImportElements(parentElem, context)
	{
		for (let i = 0, len = parentElem.children.length; i < len; ++i)
		{
			CheckForImportElement(parentElem.children[i], context);
		}
	}
	
	// Check if a given element is a relevant node (import, style, script)
	function CheckForImportElement(elem, context)
	{
		const tagName = elem.tagName.toLowerCase();

		if (tagName === "link")
		{
			const rel = elem.getAttribute("rel").toLowerCase();
			const href = elem.getAttribute("href");

			if (rel === "import")
			{
				context.dependencies.push({
					type: "import",
					url: context.baseUrl + href
				});
			}
			else if (rel === "stylesheet")
			{
				context.dependencies.push({
					type: "stylesheet",
					url: context.baseUrl + href
				});
			}
			else
			{
				console.warn("[HTMLImports] Unknown link rel: ", elem);
			}
		}
		else if (tagName === "script")
		{
			// Map the full script src to its import document for GetImportDocument().
			const scriptUrl = context.baseUrl + elem.getAttribute("src");
			scriptUrlToImportDoc.set(new URL(scriptUrl, location.origin).toString(), context.importDoc);

			context.dependencies.push({
				type: "script",
				url: scriptUrl
			});
		}
	}

	// Group an import's dependencies in to chunks we can load in parallel.
	// Basically this organises stylesheets in to a separate parallel chunk, then groups contiguous
	// script tags in to the same chunk. Imports still have to be run sequentially, but this allows
	// parallel loading of a lot of the script dependencies.
	function GroupDependencies(dependencies)
	{
		const stylesheets = [];
		const groups = [];
		let currentGroup = [];

		for (const dep of dependencies)
		{
			const type = dep.type;

			if (type === "stylesheet")
			{
				stylesheets.push(dep);
			}
			else if (!currentGroup.length)
			{
				currentGroup.push(dep);
			}
			else
			{
				const lastType = currentGroup[currentGroup.length - 1].type;

				if (lastType === "script" && type === "script")		// group contiguous scripts
				{
					currentGroup.push(dep);
				}
				else
				{
					groups.push(currentGroup);
					currentGroup = [dep];
				}
			}
		}

		if (currentGroup.length)
			groups.push(currentGroup);
		
		return {
			stylesheets, groups
		};
	};
	
	function _AddImport(url, preFetchedDoc, rootContext, progressObject)
	{
		let isRoot = false;
		
		// The initial import creates a root context, which is passed along to all sub-imports.
		if (!rootContext)
		{
			isRoot = true;
			rootContext = {
				alreadyImportedUrls: new Set(),		// for deduplicating imports
				stylePromises: [],
				scriptPromises: [],
				progress: (progressObject || {})	// progress written to this object (loaded, total)
			};

			rootContext.progress.loaded = 0;
			rootContext.progress.total = 1;			// add root import
		}
		
		// Each import also tracks its own state with its own context.
		const context = {
			importDoc: null,
			baseUrl: GetPathFromURL(url),
			dependencies: []
		};

		// preFetchedDoc is passed for sub-imports which pre-fetch their documents as an optimisation. If it's not passed,
		// fetch the URL to get the document.
		let loadDocPromise;

		if (preFetchedDoc)
			loadDocPromise = Promise.resolve(preFetchedDoc);
		else
			loadDocPromise = FetchAs(url, "document");
		
		return loadDocPromise
		.then(doc =>
		{
			context.importDoc = doc;

			// Find all interesting top-level elements (style, imports, scripts)
			FindImportElements(doc.head, context);
			FindImportElements(doc.body, context);

			// Organise these dependencies in to chunks that can be loaded simultaneously.
			const organisedDeps = GroupDependencies(context.dependencies);

			// All style can start loading in parallel. Note we don't wait on completion for these until
			// the root import finishes.
			const stylePromises = organisedDeps.stylesheets.map(dep => AddStylesheet(dep.url));
			rootContext.stylePromises.push(...stylePromises);

			// Start fetching all sub-imports in parallel, to avoid having to do a round trip for each one.
			// Map the import URL to a promise of its fetch, so we can easily wait for its load.
			const subImportFetches = new Map();

			for (const group of organisedDeps.groups)
			{
				const type = group[0].type;

				if (type === "import")
				{
					const url = group[0].url;
					
					if (!rootContext.alreadyImportedUrls.has(url))
					{
						subImportFetches.set(url, FetchAs(url, "document"));
						rootContext.alreadyImportedUrls.add(url);
						rootContext.progress.total++;
					}
				}
			}

			// Load each chunk simultaneously. This allows groups of contiguous scripts to start loading
			// simultaneously. However to preserve order of script execution, additional imports must be
			// waited on to resolve (meaning its own scripts have started loading) before we start loading
			// any later scripts in this import.
			let ret = Promise.resolve();

			for (const group of organisedDeps.groups)
			{
				const type = group[0].type;

				// Imports should be on their own, since they cannot be loaded simultaneously.
				if (type === "import")
				{
					if (group.length !== 1)
						throw new Error("should only have 1 import");
					
					// Wait for the text pre-fetch to complete, then load the import
					// and wait for its load to finish before loading anything after it.
					const url = group[0].url;
					ret = ret.then(() =>
					{
						const importFetch = subImportFetches.get(url);
						if (!importFetch)
							return null;		// de-duplicated
						
						return importFetch.then(importDoc => _AddImport(url, importDoc, rootContext))
						.then(() => rootContext.progress.loaded++);
					});
				}
				else if (type === "script")
				{
					// Wait for any prior imports to resolve, then commence loading of all scripts in this
					// group simultaneously. This allows parallel loading but guarantees sequential order
					// of execution.
					ret = ret.then(() =>
					{
						group.map(dep =>
						{
							rootContext.scriptPromises.push(AddScriptTag(dep.url));
						});
					});
				}
				else
					throw new Error("unknown dependency type");
			}

			return ret;
		})
		.then(() =>
		{
			// To speed up sub-imports, they don't wait for the scripts or stylesheets they add to finish
			// before resolving. The root level import waits, to ensure they can all complete in parallel
			// without unnecessarily holding up the loading of other sub-imports.
			if (isRoot)
			{
				return Promise.all([
					Promise.all(rootContext.stylePromises),
					Promise.all(rootContext.scriptPromises)
				])
				.then(() => rootContext.progress.loaded++);		// count root as loaded
			}
			else
			{
				return Promise.resolve();
			}
		})
		.then(() => context.importDoc)		// resolve with the main import document added
		.catch(err =>
		{
			console.error("[HTMLImports] Unable to add import '" + url + "': ", err);
		})
	}
	
	const nativeImportsSupported = ("import" in document.createElement("link"));
	const forcePolyfill = location.search.includes("use-html-imports-polyfill");
	const useNativeImports = (nativeImportsSupported && !forcePolyfill);
	
	if (!useNativeImports)
		console.log("[HTMLImports] Using polyfill");

	function AddImport(url, async, progressObject)
	{
		if (useNativeImports)
		{
			// Native path. Add <link rel="import"> to head.
			return new Promise((resolve, reject) =>
			{
				const link = document.createElement("link");
				link.onload = (() => resolve(link.import));
				link.onerror = reject;
				link.rel = "import";
				
				if (async)
					link.setAttribute("async", "");
				
				link.href = url;
				document.head.appendChild(link);
			});
		}
		else
		{
			// Polyfill path. Note async attribute ignored.
			return _AddImport(url, null, null, progressObject);
		}
	}

	function GetImportDocument()
	{
		if (useNativeImports)
		{
			// Native path: use the current script's owner document
			return document.currentScript.ownerDocument;
		}
		else
		{
			// Polyfill path: use our map of script to import document.
			const currentScriptSrc = document.currentScript.src;
			const importDoc = scriptUrlToImportDoc.get(currentScriptSrc);

			if (importDoc)
			{
				return importDoc;
			}
			else
			{
				console.warn("[HTMLImports] Don't know which import script belongs to: " + currentScriptSrc);
				return document;
			}
		}
	}

	window["addImport"] = AddImport;
	window["getImportDocument"] = GetImportDocument;
	window["hasNativeHTMLImportsSupport"] = (() => useNativeImports);
}