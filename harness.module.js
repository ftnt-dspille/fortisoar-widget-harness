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
    // window.__HARNESS_RECORD is the current View Panel / Drawer record, set
    // by index.html before bootstrap. Exposed on $rootScope so widgets that
    // walk parent scopes for `record` find it the same way they do in SOAR.
    if (window.__HARNESS_RECORD) {
      $rootScope.record = window.__HARNESS_RECORD;
    }
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

  // Minimal stand-in for SOAR's Entity resource service. Edit forms typically
  // use it to look up referenced records (e.g. dropdowns of saved templates).
  // A no-op constructor keeps controllers from blowing up on instantiation;
  // widgets that actually call methods will get clear errors so the gap is
  // discoverable rather than silent.
  app.factory("Entity", function () {
    function Entity() {}
    Entity.prototype.query = function () { return { $promise: Promise.resolve([]) }; };
    Entity.prototype.get = function () { return { $promise: Promise.resolve({}) }; };
    Entity.prototype.save = function () { return { $promise: Promise.resolve({}) }; };
    return Entity;
  });

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
  // Stand-in for SOAR's `dynamicValueChooser` directive, used heavily in
  // edit forms to let users pick fields off the current record. Real SOAR
  // pops a tree picker; the harness gives a textarea bound two-way to the
  // model so dev users can type Jinja-style expressions like
  // {{vars.input.records[0].source.host}} and exercise the round-trip.
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
