/* Harness module: creates `cybersponse` (the module widgets register against)
   and registers minimal stand-ins for the platform services our widgets inject.
   Add more stubs here as you pull in new widgets. */
"use strict";
(function () {
  const app = angular.module("cybersponse", []);

  // `config` is normally provided by the widget template service on the host
  // page. In the harness it's a value — set window.__HARNESS_CONFIG from the
  // boot page to control it per widget. Defaults are safe for most cases.
  app.value(
    "config",
    window.__HARNESS_CONFIG || { title: "(harness)", defaultTemplate: "" }
  );

  // Seed $rootScope.theme so widgets that read it at init time (before the
  // dropdown's post-bootstrap change event fires) get the right value.
  // window.__HARNESS_THEME_ID is set by index.html just before loadScript.
  app.run(["$rootScope", function ($rootScope) {
    $rootScope.theme = { id: window.__HARNESS_THEME_ID || "dark" };
  }]);

  app.factory("$state", function () {
    return (
      window.__HARNESS_STATE || {
        current: { name: "main.dashboard" },
        params: {},
      }
    );
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

  app.factory("CommonUtils", [
    "$window",
    function ($window) {
      return {
        copyToClipboard(text) {
          if ($window.navigator && $window.navigator.clipboard) {
            $window.navigator.clipboard.writeText(text);
          }
        },
      };
    },
  ]);

  app.factory("Modules", [
    "$http",
    "$q",
    function ($http, $q) {
      function Modules() {}
      Modules.prototype.get = function (params) {
        const qs = params.$relationships ? "?$relationships=true" : "";
        const url = `/api/3/${params.module}/${params.id}${qs}`;
        const deferred = $q.defer();
        $http.get(url).then(
          (r) => deferred.resolve(r.data),
          (err) => deferred.reject(err)
        );
        return { $promise: deferred.promise };
      };
      Modules.prototype.save = function (params, body) {
        const deferred = $q.defer();
        $http.post(`/api/3/${params.module}`, body).then(
          (r) => deferred.resolve(r.data),
          (err) => deferred.reject(err)
        );
        return { $promise: deferred.promise };
      };
      return Modules;
    },
  ]);

  app.factory("dynamicValueService", [
    "$http",
    function ($http) {
      return {
        evaluateJinja(jinja) {
          return $http
            .post("/api/wf/api/jinja-editor/?format=json", jinja)
            .then((r) => r.data);
        },
      };
    },
  ]);

  app.directive("csJsonEditor", function () {
    return {
      restrict: "A",
      scope: { data: "=json" },
      template: '<pre class="harness-json-view">{{ data | json }}</pre>',
    };
  });

  app.directive("csSpinner", function () {
    return {
      restrict: "E",
      template: '<i class="fa fa-spinner fa-spin harness-spinner"></i>',
    };
  });

  // Harness stand-in for SOAR's `monacoEditor` attribute directive. Keeps
  // the contract widget code uses: two-way `editor-content`/`editor-config`,
  // an `editor-changed` callback receiving the editor instance, a
  // `content-change` callback on edits, and a `monacoEditor.refresh` $on
  // hook for programmatic value resets. Expects `window.monaco` to exist
  // at link time — the widget gates the directive behind `ng-if="monacoReady"`
  // after its own ensure() resolves, so that holds.
  app.directive("monacoEditor", [
    "$timeout",
    function ($timeout) {
      return {
        restrict: "A",
        scope: {
          editorContent: "=?",
          editorConfig: "=?",
          contentChange: "&?",
          editorChanged: "&?",
        },
        template: '<div class="Monaco" style="width:100%;height:100%;"></div>',
        link: function (scope, element) {
          if (!window.monaco || !window.monaco.editor) {
            console.error(
              "[harness monacoEditor] window.monaco not ready at link time"
            );
            return;
          }
          const host = element.find("div")[0];
          const config = scope.editorConfig || {};
          config.value = scope.editorContent || "";
          const editor = window.monaco.editor.create(host, config);

          if (scope.editorChanged) scope.editorChanged({ editor: editor });

          const seed = scope.$watch("editorContent", function (val, old) {
            if (angular.isDefined(val)) {
              if (editor.getValue() !== val) editor.setValue(val);
              seed();
            } else if (val === "" && old === "") {
              seed();
            }
          });

          editor.onDidChangeModelContent(function () {
            $timeout(function () {
              const old = scope.editorContent;
              scope.editorContent = editor.getValue();
              if (scope.contentChange) {
                scope.contentChange({
                  oldContent: old,
                  newContent: scope.editorContent,
                });
              }
            }, 100);
          });

          scope.$on("monacoEditor.refresh", function () {
            $timeout(function () {
              editor.setValue(scope.editorContent || "");
            }, 100);
          });

          scope.$on("$destroy", function () {
            editor.dispose();
          });
        },
      };
    },
  ]);
})();
