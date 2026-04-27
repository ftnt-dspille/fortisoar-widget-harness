/* Harness module: creates `cybersponse` (the module widgets register against)
   and registers minimal stand-ins for the platform services our widgets inject.
   Add more stubs here as you pull in new widgets. */
"use strict";
(function () {
  // The SOAR bundle (/_fsr/app.unmin.js) creates the cybersponse module
  // upstream of this script with its dep array stripped. We just reference
  // it here and layer harness-specific factories/directives on top. If the
  // bundle failed to load (or ran before us), bail loudly rather than
  // silently masking SOAR's real services with empty stubs.
  let app;
  try {
    app = angular.module("cybersponse");
  } catch (e) {
    console.error("[harness.module.js] cybersponse module not found — did /_fsr/app.unmin.js load?", e);
    throw e;
  }

  // Real SOAR ships DOMPurify (loaded ahead of app.unmin.js) and uses it to
  // pre-clean HTML before handing it to $sce.trustAsHtml. The harness
  // provides a pass-through DOMPurify shim, so the same string reaches
  // ng-bind-html as a plain (untrusted) value and Angular throws
  // [$sce:unsafe]. Relaxing $sce to "off" in dev preview mirrors what real
  // SOAR effectively does post-DOMPurify and avoids forcing the harness to
  // ship a real DOMPurify build. This only affects the dev page; nothing
  // ships to SOAR.
  app.config(["$sceProvider", function ($sceProvider) {
    $sceProvider.enabled(false);
  }]);

  // $stomp provider stub. SOAR's websocketService factory injects $stomp
  // (provided by the angular-stomp vendor module), and websocketService is
  // a transitive dependency of playbookService. Without this stub, any
  // controller that injects playbookService — directly or via lazy
  // $injector.get — fails with `Unknown provider: $stompProvider <- $stomp`,
  // which prevents widgets like the action-renderer from running their
  // playbook source path locally.
  //
  // The stub never opens a real socket: connect() returns a never-resolving
  // promise so $rootScope.websocketConnected stays false, and the rest of
  // SOAR's playbook polling code path (checkPlaybookExecutionCompletion's
  // polling fallback at app.unmin.js:38201) takes over. That path uses
  // /api/wf/api/workflows/log_list so it works through the harness proxy.
  app.provider("$stomp", function $stompProvider() {
    this.$get = ["$q", function ($q) {
      function neverResolves() { return $q.defer().promise; }
      function noopSubscription() { return { unsubscribe: function () {} }; }
      return {
        setDebug: function () {},
        connect: function () { return neverResolves(); },
        subscribe: function () { return noopSubscription(); },
        disconnect: function () { return neverResolves(); },
        send: function () {},
      };
    }];
  });

  // Pipe Angular's exception channel into the harness debug drawer. Without
  // this override, controller/digest errors only land in DevTools — the
  // whole point of the drawer is to keep that information visible without
  // needing to keep the console open. Also re-throws so DevTools breakpoints
  // still fire on `Pause on caught exceptions`.
  app.factory("$exceptionHandler", ["$log", function ($log) {
    return function (exception, cause) {
      try {
        if (window.__harnessReportError) {
          window.__harnessReportError({
            source: "angular",
            message: (exception && exception.message) || String(exception),
            stack: (exception && exception.stack) || null,
            cause: cause || null,
          });
        }
      } catch (_) {}
      $log.error.apply($log, arguments);
    };
  }]);

  // `config` is normally provided by the widget template service on the host
  // page. In the harness it's read from window.__HARNESS_CONFIG, which the
  // boot page rewrites before each angular.bootstrap (initial mount, edit
  // modal open, post-save remount). Registered as a factory so each injector
  // pulls the current global instead of the snapshot at module load.
  app.factory("config", function () {
    return window.__HARNESS_CONFIG || { title: "(harness)", defaultTemplate: "" };
  });

  // Seed $rootScope.theme so widgets that read it at init time (before the
  // dropdown's post-bootstrap change event fires) get the right value.
  // window.__HARNESS_THEME_ID is set by index.html just before loadScript.
  // Preload module metadata so widgets that call modelMetadatasService.getMetadataByModuleType
  // (Entity, csChart, csCardCount, etc.) find "alerts", "incidents", etc. in localStorage.
  // SOAR's appInitializeService normally drives this on login; the harness skips that path,
  // so we trigger it directly. Failures are logged but non-fatal — widgets that don't need
  // metadata still work.
  app.run(["modelMetadatasService", "$log", function (modelMetadatasService, $log) {
    try {
      modelMetadatasService.loadAllModules(true).then(
        function () { window.__HARNESS_MMD_LOADED = true; },
        function (e) { $log.warn("[harness] loadAllModules failed", e); }
      );
    } catch (e) { $log.warn("[harness] loadAllModules threw", e); }
  }]);

  // SOAR's app/components/form/fields/input.html uses interpolation in
  // attribute values (`placeholder="{{ ::placeholder }}"`,
  // `class="... {{ value.length>0 ? ... : '' }} ..."`). When that template is
  // fetched at runtime in the harness and compiled into a cs-field instance
  // through cs-connector-field-renderer, the {{}}/`::` binds end up frozen
  // as literal text in the rendered DOM (the input shows "{{ ::placeholder }}"
  // verbatim). Real SOAR ships these templates pre-compiled into
  // $templateCache, sidestepping the timing issue. Mirror that by stuffing a
  // clean variant into the cache before any cs-field directive resolves it.
  app.run(["$templateCache", function ($templateCache) {
    var cleanInput = [
      '<div class="display-flex">',
      '  <input',
      '    type="text"',
      '    class="form-control"',
      '    data-ng-attr-id="{{formName + \'-\' + field.name}}"',
      '    data-ng-attr-name="{{field.name}}"',
      '    data-ng-model="$parent.value"',
      '    data-ng-required="field.required"',
      '    data-ng-readonly="disabled"',
      '    data-ng-attr-placeholder="{{placeholder}}"',
      '    data-ng-change="changeMethod(value, field)"',
      '    data-ng-blur="blurMethod(value)"',
      '    autocomplete="off"',
      '    spellcheck="false" />',
      '</div>',
    ].join("");
    // Cover both keying conventions; $templateRequest normalizes against
    // <base href> but the lookup key is the raw URL passed in.
    $templateCache.put("app/components/form/fields/input.html", cleanInput);
    $templateCache.put("/app/components/form/fields/input.html", cleanInput);
  }]);

  app.run(["$rootScope", function ($rootScope) {
    $rootScope.theme = { id: window.__HARNESS_THEME_ID || "dark" };
    // window.__HARNESS_RECORD is the current View Panel / Drawer record, set
    // by index.html before bootstrap. Exposed on $rootScope so widgets that
    // walk parent scopes for `record` find it the same way they do in SOAR.
    if (window.__HARNESS_RECORD) {
      $rootScope.record = window.__HARNESS_RECORD;
    }
  }]);

  // ui.router is NOT bundled in app.unmin.js (it's a vendor dep we stripped),
  // so $state has no real source. Stub it for the harness.
  app.factory("$state", function () {
    // SOAR's csChart link passes $state.params.page through $interpolate,
    // which throws on undefined. Provide a default page name; the harness
    // page selector can override via window.__HARNESS_STATE.
    return (
      window.__HARNESS_STATE || {
        current: { name: "main.dashboard" },
        params: { page: "dashboard" },
        go: function () {},
      }
    );
  });

  // Entity and CommonUtils ARE provided by app.unmin.js (registered against
  // cybersponse via .factory) — don't stub here.

  // angular-clipboard — vendor stripped. CommonUtils injects `clipboard`.
  app.factory("clipboard", ["$window", function ($window) {
    return {
      supported: !!($window.navigator && $window.navigator.clipboard),
      copyText: function (text) {
        if ($window.navigator && $window.navigator.clipboard) {
          $window.navigator.clipboard.writeText(text);
        }
      },
      toClipboard: function (text) { this.copyText(text); },
    };
  }]);

  // ui.bootstrap ($uibModal) — vendor module stripped. Stub returns a
  // never-resolving modal; widgets that try to .open one in the harness
  // will silently no-op (acceptable for our mount-and-render scope).
  app.factory("$uibModal", ["$q", function ($q) {
    return {
      open: function () {
        var d = $q.defer();
        return { result: d.promise, opened: $q.when(true), rendered: $q.when(true), closed: d.promise, dismiss: function(){}, close: function(){} };
      },
    };
  }]);

  // angular-translate `translate` filter — used heavily in SOAR templates
  // (`{{ "APP.LABEL.X" | translate }}` and `'K' | translate: { p: v }`).
  // Looks up the dotted/flat key in __HARNESS_TRANSLATIONS, then interpolates
  // any `{{paramName}}` placeholders in the resolved string against the
  // supplied params map. Without param interpolation, strings like
  // COMPONENTS.FORM.TYPEAHEAD.MULTI_SELECT_DROPDOWN render literal `{{ ... }}`
  // through ng-bind-html (which does not compile expressions).
  function harnessTranslateLookup(key) {
    var dict = window.__HARNESS_TRANSLATIONS || {};
    if (Array.isArray(key)) key = key[0];
    if (typeof key !== "string") return key;
    if (typeof dict[key] === "string") return dict[key];
    var node = dict;
    var parts = key.split(".");
    for (var i = 0; i < parts.length; i++) {
      if (node && typeof node === "object" && parts[i] in node) {
        node = node[parts[i]];
      } else { return key; }
    }
    return (typeof node === "string") ? node : key;
  }
  // Resolve `{{ expr }}` placeholders against a params map. Uses Angular's
  // own `$interpolate` so semantics match SOAR exactly — most notably,
  // undefined sub-expressions (e.g. `value.display` when value is empty)
  // coerce to "" instead of the JS string "undefined" that Function-eval
  // produces. Falls back to "" on any parse error.
  app.filter("translate", ["$interpolate", function ($interpolate) {
    var f = function (key, params) {
      var str = harnessTranslateLookup(key);
      if (typeof str !== "string" || str.indexOf("{{") === -1) return str;
      try { return $interpolate(str)(params || {}); } catch (_) { return ""; }
    };
    f.$stateful = false;
    return f;
  }]);

  // angular-translate ($translate) — vendor module stripped. SOAR's
  // translationService -> statusCodeService -> Entity -> CommonUtils chain
  // injects it. Identity stub: returns the key (or first element if array).
  app.factory("$translate", ["$q", "$interpolate", function ($q, $interpolate) {
    // Same lookup + Angular-semantics param interpolation as the filter above.
    function id(k, params) {
      var str = harnessTranslateLookup(k);
      if (typeof str !== "string" || str.indexOf("{{") === -1) return str;
      try { return $interpolate(str)(params || {}); } catch (_) { return ""; }
    }
    function translate(k, params) { return $q.when(id(k, params)); }
    translate.instant = function (k, params) { return id(k, params); };
    translate.use = function () { return "en"; };
    translate.refresh = function () { return $q.when(true); };
    translate.proposedLanguage = function () { return null; };
    translate.preferredLanguage = function () { return "en"; };
    translate.fallbackLanguage = function () { return "en"; };
    translate.storageKey = function () { return "NG_TRANSLATE_LANG_KEY"; };
    translate.onReady = function () { return $q.when(true); };
    return translate;
  }]);

  // LocalStorageModule (vendor) was stripped from the dep array, so its
  // localStorageService isn't registered. SOAR's CommonUtils -> appModulesService
  // injects it. Back it with window.localStorage.
  app.factory("localStorageService", ["$window", function ($window) {
    var ls = $window.localStorage;
    var prefix = "cs.";
    function key(k) { return prefix + k; }
    return {
      get: function (k) { try { return JSON.parse(ls.getItem(key(k))); } catch { return ls.getItem(key(k)); } },
      set: function (k, v) { ls.setItem(key(k), typeof v === "string" ? v : JSON.stringify(v)); return true; },
      remove: function (k) { ls.removeItem(key(k)); return true; },
      clearAll: function () { /* harness no-op: avoid nuking unrelated keys */ },
      keys: function () {
        var out = [];
        for (var i = 0; i < ls.length; i++) {
          var n = ls.key(i);
          if (n && n.indexOf(prefix) === 0) out.push(n.slice(prefix.length));
        }
        return out;
      },
      length: function () { return this.keys().length; },
      isSupported: true,
      getStorageType: function () { return "localStorage"; },
      setStorageType: function () { return "localStorage"; },
      cookie: { isSupported: false, set: function(){}, get: function(){}, remove: function(){} },
      deriveKey: key,
    };
  }]);

  // Cryptography eagerly reads $window.CryptoJS.enc.Hex.parse(...) at factory
  // instantiation (app.unmin.js:46952), so any service that injects it —
  // tokenService -> websocketService -> playbookService — fails to instantiate
  // in the harness with "Cannot read properties of undefined (reading 'enc')".
  // We don't need real crypto in the harness (the proxy handles auth), so
  // override with a passthrough stub. The TOKEN cache in localStorage is
  // irrelevant here.
  app.factory("Cryptography", function () {
    var t;
    var api = {
      encrypt: function (v) { return v; },
      decrypt: function (v) { return v; },
      setAuthToken: function (v) { t = v; },
      getAuthToken: function () { return t; },
      updateAuthToken: function () {},
    };
    return api;
  });

  app.factory("toaster", [
    "$document",
    function ($document) {
      function pop(kind, opts) {
        const body = (opts && opts.body) || "";
        console.log(`[toaster.${kind}] ${body}`);
        const tray = $document[0].getElementById("harness-toasts");
        if (!tray) return;
        const el = $document[0].createElement("div");
        el.className = `harness-toast harness-toast-${kind}`;
        el.textContent = `${kind.toUpperCase()}: ${body}`;
        tray.appendChild(el);
        setTimeout(() => el.remove(), 3500);
      }
      return {
        success: (o) => pop("success", o),
        error: (o) => pop("error", o),
        warning: (o) => pop("warning", o),
        info: (o) => pop("info", o),
      };
    },
  ]);

  // Stub for the angular-ui-bootstrap modal instance. In SOAR, edit forms run
  // inside a $uibModal, so their controllers inject $uibModalInstance and
  // call .close()/.dismiss() to wire up the bootstrap modal Save/Cancel
  // buttons. The harness exposes its own Save/Cancel in the modal chrome,
  // so these stubs are no-ops — Save/Cancel in the harness toolbar drives
  // the persist + remount path instead.
  app.factory("$uibModalInstance", function () {
    return {
      close: function () {},
      dismiss: function () {},
      result: { then: function () {}, catch: function () {} },
    };
  });

  // Entity and CommonUtils intentionally NOT stubbed — SOAR's app.unmin.js
  // registers the real implementations. Re-add stubs only if a specific
  // method is missing and we don't want to load the upstream source.

  // Override SOAR's currentPermissionsService — the real one walks loaded user
  // RBAC data we don't bootstrap in the harness, so every availablePermission()
  // returns false and widgets toast "necessary permission" errors. Grant all.
  app.factory("currentPermissionsService", function () {
    return {
      availablePermission: function () { return true; },
      availableFieldPermission: function () { return true; },
      get: function () { return {}; },
      loadCurrentUser: function () { return { then: function (cb) { cb && cb(); return this; }, catch: function(){ return this; } }; },
      getPermissions: function () { return {}; },
    };
  });

  // Modules: provided by SOAR's app.unmin.js (real $resource-backed factory).
  // Earlier harness builds defined a hand-rolled $http stub here — removed
  // because it shadowed the real one and broke modelMetadatasService.

  // $resource: provided by the ngResource vendor module loaded in index.html
  // and listed in HARNESS_VENDOR_DEPS. Don't stub here — would shadow the
  // real implementation and break $resource(API.QUERY+...).save() calls.

// chartService: real implementation lives in the c3charts widgetAssets/
  // bundle that SOAR loads at runtime; the harness doesn't load widget
  // assets, so register a stub that satisfies the injector.
  app.factory("chartService", ["$q", function ($q) {
    return {
      buildAggregationQuery: function () { return {}; },
      formatChartData: function () { return { data: { columns: [], type: "pie" } }; },
      getRelatedModules: function () { return $q.resolve([]); },
      getFieldMetadata: function () { return $q.resolve(null); },
    };
  }]);

app.factory("dynamicValueService", [
    "$http",
    function ($http) {
      return {
        evaluateJinja(jinja) {
          return $http
            .post("/api/wf/api/jinja-editor/?format=json", jinja)
            .then((r) => r.data);
        },
        // Real SOAR's dynamicValueService exposes these jinja helpers; the
        // cs-typeahead directive (used by the cs-conditional value picker)
        // calls isJinjaConvertibleToTag during link, so without the stub
        // every typeahead-backed field throws "isJinjaConvertibleToTag is
        // not a function" and won't render its value picker. Returning
        // false means "not jinja-convertible" — same default behavior as
        // when the user hasn't enabled jinja-to-tag globally.
        isJinjaConvertibleToTag(_value) { return false; },
        isJinja(value) {
          return typeof value === "string" &&
            (value.indexOf("vars.") !== -1 || value.indexOf("globalVars.") !== -1 ||
             value.indexOf("{{") !== -1 || value.indexOf("{%") !== -1);
        },
      };
    },
  ]);

  // csJsonEditor, csSpinner, monacoEditor directives intentionally NOT
  // registered here — they are all defined by app.unmin.js and registering
  // them again triggers $compile:multidir on isolated-scope directives.
  // Use SOAR\'s real implementations instead (more realistic anyway).

  // DEPRECATED: ui.bootstrap (loaded from CDN) provides real uibDropdown,
  // uibDropdownToggle, uibDropdownMenu directives + uibPopover. Removing the
  // harness shims here so the real implementations take over. The ui-bootstrap
  // CSS + JS are loaded in index.html and ui.bootstrap is listed in
  // HARNESS_VENDOR_DEPS so cybersponse can inject its providers.

  // Stand-in for SOAR's `dynamicValueChooser` directive, used heavily in
  // edit forms to let users pick fields off the current record. Real SOAR
  // pops a tree picker; the harness gives a textarea bound two-way to the
  // model so dev users can type Jinja-style expressions like
  // {{vars.input.records[0].source.host}} and exercise the round-trip.

  // moduleAttribute provider: SOAR's bundle calls .attribute(name, def) for
  // ~45 field types via .config() blocks on cybersponse. In the harness those
  // config blocks aren't running (likely because of how we patch the dep
  // array), leaving the registry empty — csField then can't resolve any
  // field type and renders nothing for filter values, etc. Re-populate the
  // `types` map post-bootstrap; the service hands out the same reference,
  // so mutating it is enough.
  app.run(["moduleAttribute", function (moduleAttribute) {
    if (!moduleAttribute || !moduleAttribute.types) return;
    if (Object.keys(moduleAttribute.types).length > 0) return; // real config ran
    var FIELD_DEFS = [
      ["text",                    "text",            "string",   "app/components/form/fields/input.html"],
      ["password",                "password",        "string",   "app/components/form/fields/password.html"],
      ["checkbox",                "checkbox",        "boolean",  "app/components/form/fields/checkbox.html"],
      ["checkbox.select",         "",                "",         "app/components/form/fields/checkbox.select.html"],
      ["integer",                 "integer",         "integer",  "app/components/form/fields/integer.html"],
      ["decimal",                 "decimal",         "number",   "app/components/form/fields/number.html"],
      ["datetime",                "datetime",        "integer",  "app/components/form/fields/datetime.html"],
      ["datetime.advance",        "",                "",         "app/components/form/fields/datetime.advance.html"],
      ["datetime.quick",          "",                "",         "app/components/form/fields/datetime.quick.html"],
      ["datetime.grid",           "",                "",         "app/components/form/fields/datetime.grid.html"],
      ["datetime.defaultValue",   "",                "",         "app/components/form/fields/datetime.defaultValue.html"],
      ["datetime.playbook",       "",                "",         "app/components/form/fields/datetime.playbook.html"],
      ["phone",                   "phone",           "string",   "app/components/form/fields/phone.html"],
      ["email",                   "email",           "string",   "app/components/form/fields/email.html"],
      ["dynamicList",             "dynamicList",     "array",    "app/components/form/fields/dynamicList.html"],
      ["select",                  "select",          "select",   "app/components/form/fields/select.html"],
      ["select.input",            "select",          "string",   "app/components/form/fields/selectInput.html"],
      ["jinja.input",             "text",            "string",   "app/components/form/fields/input.html"],
      ["array",                   "text",            "string",   "app/components/form/fields/input.html"],
      ["multiselect",             "multiselect",     "string",   "app/components/form/fields/multiselect.html"],
      ["file",                    "file",            "string",   "app/components/form/fields/file.html"],
      ["richtext",                "richtext",        "string",   "app/components/form/fields/markdownEditor.html"],
      ["html",                    "html",            "string",   "app/components/form/fields/htmlEditor.html"],
      ["json",                    "textarea",        "string",   "app/components/form/fields/json.html"],
      ["object",                  "object",          "object",   "app/components/form/fields/json.html"],
      ["textarea",                "textarea",        "string",   "app/components/form/fields/textarea.html"],
      ["image",                   "image",           "",         "app/components/form/fields/image.html"],
      ["picklist",                "picklist",        "picklists","app/components/form/fields/typeahead.html"],
      ["multiselectpicklist",     "multiselectpicklist","picklists","app/components/form/fields/typeahead.multiselect.html"],
      ["picklist.multi",          "",                "",         "app/components/form/fields/picklist.multi.html"],
      ["lookup",                  "lookup",          "",         "app/components/form/fields/typeahead.html"],
      ["oneToMany",               "oneToMany",       "",         ""],
      ["manyToMany",              "manyToMany",      "",         "app/components/form/fields/typeahead.multiselect.html"],
      ["toManyList",              "manyToMany",      "",         "app/components/form/fields/typeahead.multiselect.html"],
      ["relationshipFields.playbook","",             "",         "app/components/form/fields/input.html"],
      ["label",                   "label",           "string",   "app/components/form/fields/label.html"],
      ["domain",                  "domain",          "string",   "app/components/form/fields/webAddress.html"],
      ["url",                     "url",             "string",   "app/components/form/fields/url.html"],
      ["filehash",                "filehash",        "string",   "app/components/form/fields/fileHash.html"],
      ["livesync",                "livesync",        "",         "app/components/form/fields/livesync.html"],
      ["tags",                    "tags",            "tags",     "app/components/form/tags/tags.html"],
      ["certificate",             "certificate",     "string",   "app/components/form/fields/certificate.html"],
      ["date",                    "date",            "integer",  "app/components/form/fields/date.html"],
      ["codeEditor",              "codeEditor",      "codeEditor","app/components/form/fields/codeEditor.html"],
      ["emailTemplate",           "emailTemplate",   "string",   "app/components/form/fields/emailTemplate.html"],
    ];
    FIELD_DEFS.forEach(function (def) {
      moduleAttribute.types[def[0]] = {
        formType: def[1] || def[0],
        type: def[2],
        templateUrl: def[3],
        usable: true,
        mmdUpdate: true,
      };
    });
    console.log("[harness.module.js] populated moduleAttribute.types with", FIELD_DEFS.length, "field defs");
  }]);

  app.directive("dynamicValueChooser", function () {
    return {
      restrict: "EA",
      scope: { ngModel: "=", placeholder: "@?" },
      template:
        '<textarea class="harness-dvc form-control" rows="2" ' +
        '          ng-model="ngModel" ' +
        '          placeholder="{{ placeholder || \'{{ jinja or record.path }}\' }}">' +
        "</textarea>",
    };
  });

})();
