# FortiSOAR AngularJS Widget Development — Knowledgebase

Comprehensive reference for building FortiSOAR 7.x widgets. Derived from:

- `FortiSOAR-7.6.5-Widget_Development.pdf` (authoritative guide)
- Deep analysis of 60 certified widgets in `widgets-extracted/`
- Online service API index: <https://fortisoar.contenthub.fortinet.com/widgetServiceAPI/>

> **Scope.** Widgets are AngularJS 1.x components rendered inside the FortiSOAR SPA (module `cybersponse`). You cannot use Angular 2+/React/Vue. You inherit the host's injectors, directives, filters, theme variables, CSS, and WebSocket channel.

---

## Table of Contents

1. [Mental model & where widgets live](#1-mental-model)
2. [Widget anatomy: files & folder layout](#2-widget-anatomy)
3. [`info.json` schema (complete)](#3-infojson-schema)
4. [Page contexts: Dashboard, View Panel, Listing, Drawer, ...](#4-page-contexts)
5. [View controller vs. edit controller](#5-controllers)
6. [Edit form (`edit.html`) patterns](#6-edit-form-patterns)
7. [View template (`view.html`) patterns](#7-view-template-patterns)
8. [Services catalog](#8-services-catalog)
9. [Directives catalog](#9-directives-catalog)
10. [Filters](#10-filters)
11. [Querying data: `Query`, `PagedCollection`, `Entity`, `Modules`](#11-querying-data)
12. [Accessing the current record (View Panel context)](#12-current-record)
13. [`config.mapping` — the field-mapping convention](#13-config-mapping)
14. [Theme awareness (`$rootScope.theme`)](#14-theme)
15. [WebSocket subscriptions (real-time)](#15-websocket)
16. [AngularJS events (`$emit` / `$broadcast` / `$on`)](#16-events)
17. [Wizard / multi-step widgets (`WizardHandler`)](#17-wizards)
18. [Drawer / non-modal widgets (`contexts`, `enableFor`)](#18-drawer-widgets)
19. [Triggering playbooks](#19-triggering-playbooks)
20. [Connector-driven data (`connectorService`, `modelMetadatasService`)](#20-connectors)
21. [Permissions (`currentPermissionsService`)](#21-permissions)
22. [External CDN / JS / CSS loading](#22-external-assets)
23. [Internationalisation (`widgetUtility.service.js` + `locales/`)](#23-i18n)
24. [Widget-to-widget communication (broadcast events)](#24-cross-widget)
25. [Recipes — scaffolds per widget type](#25-recipes)
26. [Widget catalog (60 certified widgets)](#26-catalog)
27. [Cheatsheets (what to reach for)](#27-cheatsheets)
28. [Common pitfalls](#28-pitfalls)
29. [Platform source references (host UI code)](#29-platform-source-references-host-ui-code)
30. [Appendix A — `API` constants](#appendix-a-api-constants)
31. [Appendix B — Supported field `formType`s](#appendix-b-formtypes)

---

## 1. Mental model

A FortiSOAR widget is a **registered AngularJS controller + HTML template pair** that the platform instantiates inside a configurable slot. There are two lifecycles:

- **Edit-time** (`edit.html` + `edit.controller.js`): opened as a `$uibModal` when a user adds/edits the widget on a dashboard, Report, Listing, View Panel, etc. Collects a `config` object and closes with `$uibModalInstance.close($scope.config)`.
- **Run-time** (`view.html` + `view.controller.js`): rendered in-place on the host page. Receives `config` via injection and has access to the host's `$state`, `$rootScope`, the parent form (`FormEntityService`), the WebSocket, and all platform services.

You are working inside the host module:

```js
angular.module("cybersponse").controller("myWidget101Ctrl", ...);
```

Every non-trivial widget version embeds the `version` in the controller name (`myWidget101Ctrl` for version 1.0.1) so multiple versions of the same widget can coexist in one install. **This is a hard convention — follow it.**

The platform loads the widget via its name + version path:

```
widgets/installed/<name>-<version>/widgetAssets/...
```

Asset references in `view.html` must use this prefix (see §7).

> **Gotcha — harness lint blocks bootstrap on ANY stale version-string literal in the controller, including comments.** After bumping `info.json` (e.g. 1.0.47→1.0.48), the dev/test harness runs a `stale-version-ref` lint and *refuses to mount the widget* if `view.controller.js` contains the old `M.m.p` string anywhere — even an example URL in a code comment. Symptom: every Playwright e2e times out at `waitForFunction(() => window.__<widget>__)` because the controller never boots; the harness error panel shows `Lint blocked widget bootstrap … [stale-version-ref] references stale version(s): 1.0.47`. The jest bootstrap slug test (`fsrPlaybookBuilder1048DevCtrl`) does NOT catch this — it only checks `…NNNNCtrl` tokens, not literal `1.0.47` dotted strings. Fix: grep the controller for the old dotted version and update every hit (comments included) in the same bump. **Better: never write the dotted version in the controller at all** — derive it from the served script URL (`fsrPlaybookBuilder` does this via `WIDGET_VERSION`) and use a `<version>` placeholder in comments. A jest guard (`triageDraft.export.test.js`: "controller never hardcodes the info.json WIDGET version") asserts `info.json.version` never appears literally in `view.controller.js`, so the footgun can't recur.

---

## 2. Widget anatomy

Minimum files:

```
<widgetName>/
├── info.json                 # Metadata, pages, contexts, compatibility
├── view.html                 # Runtime template (required)
├── view.controller.js        # Runtime controller (required)
├── edit.html                 # Edit-time template (required; may be a stub)
├── edit.controller.js        # Edit-time controller (required; may just close modal)
├── release_notes.md          # Optional but strongly recommended
├── images/
│   ├── <widget>_view.png     # Used in content hub preview
│   └── <widget>_edit.png
└── widgetAssets/             # All non-core files go here
    ├── css/<widget>.css
    ├── js/
    │   ├── widgetUtility.service.js   # Required for localized widgets (see §23)
    │   └── <widget>.service.js        # Optional: pull logic out of the controller
    ├── html/
    │   └── <partial>.html
    ├── images/...             # SVGs, logos, static assets
    └── locales/               # i18n JSON (see §23)
        ├── en.json
        ├── fr_fr.json
        ├── ja.json
        ├── ko.json
        ├── zh_cn.json
        └── zh_tw.json
```

Packaging is a tar-gzip: `<widgetName>-<version>.tgz` built over that directory. Every `.js`, `.css`, `.html` must carry the MIT copyright header (see §25).

---

## 3. `info.json` schema

This file drives **everything** — where the widget is shown, whether it's modal, what compatibility banner it gets, and which controller the platform registers. Every field seen across the 60 certified widgets:

```jsonc
{
  "name": "myWidget",              // Kebabless camelCase. Becomes the path prefix & controller basename.
  "title": "My Widget",            // Shown in widget catalogs
  "subTitle": "One-line pitch.",   // Short description (note casing: subTitle)
  "version": "1.0.0",              // MAJOR.MINOR.PATCH (drives controller suffix: myWidget100Ctrl)
  "published_date": 1706787666,    // Unix seconds. Integer or numeric string — both are accepted
  "releaseNotes": "available",     // "available" | "unavailable" — hints UI to show the tab
  "development": false,            // Set true while iterating in Content Hub; false when shipping

  "metadata": {
    // ── Display & catalog ──────────────────────────────────────────────
    "description": "Long HTML or markdown description.",
    "publisher":   "Fortinet",     // Organization shown in Content Hub
    "certified":   "Yes",          // "Yes" | "No"
    "compatibility": ["7.2.0", "7.4.1", "7.6.0"],  // Min FortiSOAR versions the widget runs on
    "help_online": "https://github.com/.../release/1.0.0/README.md",
    "snapshots":  [ "<absolute URL to PNG>", "..." ],   // Preview images
    "logo":       "data:image/png;base64,...",          // Drawer/icon representation
    "category":   ["Machine Learning", "Utilities", "FortiSOAR Essentials"],

    // ── Where the widget is embeddable ─────────────────────────────────
    // Any combination of: "Dashboard", "Reports", "View Panel", "Listing",
    // "Add Form", "Settings" (rare). Empty array means "not a page widget"
    // (usually because contexts is set instead).
    "pages": ["Dashboard", "View Panel"],

    // ── Widget sizing / modal behavior ─────────────────────────────────
    "standalone":  true,           // Can be launched on its own (not embedded in a dashboard cell)
    "windowClass": "Full Width",   // "Full Width" | "Half Width" — modal/drawer size
    "size":        "lg",           // Legacy: large widget grid cell

    // ── Drawer / non-modal contexts ────────────────────────────────────
    // See §18. Declares the widget can float outside any page cell.
    "contexts": ["drawer", "pb_designer", "header_navbar", "launch_on_boot"],

    // ── Drawer/standalone rendering properties ─────────────────────────
    // (Only relevant when contexts includes "drawer" or standalone = true.)
    "view": {
      "popup":       "custom",     // "custom" makes background interactive (non-blocking)
      "draggable":   true,         // Allow user to drag the floating window
      "activeBackground": true,    // Background not blurred
      "displayName": "FortiAI",    // Label next to the drawer icon; omit to show logo only
      "enableFor": [               // UI-Router state names where the drawer icon appears
        "main.modules.list",
        "viewPanel.modulesDetail",
        "main.playbookDetail",
        "main.marketplace.workspace",
        "main.dashboard"
      ]
    }
  }
}
```

### Key rules & common mistakes

- **`pages` vs. `contexts`.** A widget is placed on a dashboard/Report/View Panel/Listing through `pages`. It floats as a drawer/launcher through `contexts`. A widget can use both (e.g., show on View Panel *and* have a drawer icon).
- **`compatibility`** is a *list*, not a range. Include each supported major.minor you've tested.
- **`subTitle`** — note the capital `T`. A lowercase `subtitle` is silently ignored.
- **`published_date`** — integer seconds. Some older widgets store it as a numeric string; both work.
- **`name`** must match the top-level folder name inside the tarball. The platform uses `name-version` as the path.
- **Controller suffix convention.** `name: "myWidget"`, `version: "1.0.0"` → register `myWidget100Ctrl` and `editMyWidget100Ctrl`. The platform expects this naming.
- **No `pages` at all** = widget isn't selectable in widget pickers. Settings-page widgets, drawer-only widgets, and widgets launched programmatically typically use `"pages": []`.
- **Snapshot URLs** must be absolute and publicly accessible. The Content Hub embeds them by URL.

### Minimal `info.json` for each common shape

```jsonc
// Dashboard chart
{ "name": "foo", "title": "Foo", "subTitle": "…", "version": "1.0.0",
  "published_date": 1700000000,
  "metadata": { "pages": ["Dashboard", "Reports"], "certified": "No", "publisher": "You",
                "compatibility": ["7.4.1"], "description": "…" } }

// View-Panel record widget
{ ..., "metadata": { "pages": ["View Panel"], ... } }

// Drawer / AI-assistant-style floating widget
{ ..., "metadata": { "pages": [],
                     "contexts": ["drawer"],
                     "standalone": true, "windowClass": "Half Width",
                     "view": { "popup": "custom", "draggable": true,
                               "displayName": "My Bot",
                               "enableFor": ["viewPanel.modulesDetail"] },
                     ... } }

// Full-screen standalone wizard (no page embedding)
{ ..., "metadata": { "pages": [], "standalone": true, "windowClass": "Full Width", ... } }
```

---

## 4. Page contexts

### 4.1 `pages` values

| Value | Where it appears | `config.module` meaning | Record access |
|---|---|---|---|
| `Dashboard` | Dashboard grid cell | Chosen by user at edit time | n/a — widget loads its own data |
| `Reports` | Report templates | Chosen by user | n/a |
| `View Panel` | Record details pane | Record's own module (implicit) | `$state.params.module` / `$state.params.id` |
| `Listing` | Module list page header/footer | Module being listed | n/a (use PagedCollection on that module) |
| `Add Form` | Create-record dialog | Record being created | `FormEntityService.get()` |
| `Settings` | System Settings pane | — | `$http`/`$resource` on system endpoints |

### 4.2 `contexts` values

| Value | Behavior |
|---|---|
| `drawer` | Icon in the right-hand drawer rail; opens as a floating non-modal panel |
| `pb_designer` | Icon inside the Playbook Designer's toolbar |
| `header_navbar` | Custom tile in the top-bar launcher (e.g., Setup Guide) |
| `launch_on_boot` | Launched automatically at app startup |

### 4.3 UI-Router state names (for `view.enableFor`)

| State | Page |
|---|---|
| `main.dashboard` | Dashboards |
| `main.modules.list` | Module listings (Alerts, Incidents, …) |
| `viewPanel.modulesDetail` | Record detail view |
| `main.playbookDetail` | Playbook designer detail |
| `main.marketplace.workspace` | Content Hub workspace |
| `main.reports` | Reports |

The widget's drawer icon is rendered on any state whose name **starts with** one of the values. `"main.modules.list"` matches both the listing and its child states.

### 4.4 Detecting the current context at runtime

```js
// Are we on the View Panel?
const isViewPanelPage = $state.current && $state.current.name.indexOf('viewPanel') !== -1;

// Are we on the Dashboard?
const page = $state.params.page;    // 'dashboard' | 'reporting' | …
// or
const isDashboard = $state.current.name === 'main.dashboard';
```

Chart widgets commonly branch their header CSS on `page === 'dashboard'` (see `recordCard-1.0.1/view.html:7-14`).

---

## 5. Controllers

### 5.1 Skeleton — view controller

```js
/* Copyright start
   MIT License
   Copyright (c) 2025 Fortinet Inc
   Copyright end */
"use strict";
(function () {
  angular
    .module("cybersponse")
    .controller("myWidget100Ctrl", myWidget100Ctrl);

  // Explicit DI is mandatory — minification will otherwise break the widget.
  myWidget100Ctrl.$inject = [
    '$scope', '$rootScope', '$state', '$timeout',
    'config', 'PagedCollection', 'Query',
    'appModulesService', 'currentPermissionsService'
  ];

  function myWidget100Ctrl(
    $scope, $rootScope, $state, $timeout,
    config, PagedCollection, Query,
    appModulesService, currentPermissionsService
  ) {
    $scope.config = config;       // Always keep config on $scope — the template binds to it.
    $scope.processing = true;
    $scope.getList   = getList;   // Functions the template can call.

    function init() {
      const perms = currentPermissionsService.getPermission($scope.config.module);
      if (!perms.read) { $scope.unauthorized = true; return; }

      getList();
    }

    function getList() {
      const coll = new PagedCollection($scope.config.module, null,
                                       { $limit: $scope.config.query.limit });
      coll.query = new Query($scope.config.query);
      coll.loadGridRecord()
        .then(() => { $scope.fieldRows = coll.fieldRows; })
        .finally(() => { $scope.processing = false; });
    }

    $scope.$on('$destroy', function () { /* unsubscribe websockets, destroy charts, etc. */ });
    init();
  }
})();
```

### 5.2 Skeleton — edit controller

```js
"use strict";
(function () {
  angular
    .module("cybersponse")
    .controller("editMyWidget100Ctrl", editMyWidget100Ctrl);

  editMyWidget100Ctrl.$inject = [
    '$scope', '$uibModalInstance', 'config',
    'appModulesService', 'Entity'
  ];

  function editMyWidget100Ctrl(
    $scope, $uibModalInstance, config,
    appModulesService, Entity
  ) {
    $scope.cancel = () => $uibModalInstance.dismiss('cancel');
    $scope.save   = save;
    $scope.loadAttributes = loadAttributes;

    function init() {
      const defaults = { mapping: { cardTitle: null, subtitle: null }, query: { limit: 10 } };
      $scope.config = angular.extend({}, defaults, config);

      appModulesService.load(true).then((mods) => {
        $scope.modules = mods;
        if ($scope.config.module) loadAttributes();
      });
    }

    function loadAttributes() {
      const entity = new Entity($scope.config.module);
      entity.loadFields().then(() => {
        $scope.fields       = entity.getFormFields();
        $scope.fieldsArray  = entity.getFormFieldsArray();
        $scope.pickListFields = Object.values(entity.fields)
                                      .filter(f => f.type === 'picklist');
      });
    }

    function save() {
      if ($scope.editMyWidgetForm.$invalid) {
        $scope.editMyWidgetForm.$setTouched();
        if ($scope.editMyWidgetForm.$focusOnFirstError) {
          $scope.editMyWidgetForm.$focusOnFirstError();
        }
        return;
      }
      $uibModalInstance.close($scope.config);
    }

    init();
  }
})();
```

### 5.3 Injectables you will almost always want

Group | Typical for | Injectables
---|---|---
**Core** | Every widget | `$scope`, `config`, `$timeout`, `$rootScope`
**Edit modal** | `edit.controller.js` | `$uibModalInstance`, `appModulesService`, `Entity`
**Querying** | List/chart widgets | `PagedCollection`, `Query`, `API`, `$http`, `$resource`, `_` (underscore)
**View Panel** | Record widgets | `$state`, `Modules`, `FormEntityService`, `websocketService`
**Playbooks** | Button/CTA widgets | `playbookService`, `widgetService`
**Connectors** | Enrichment widgets | `connectorService`, `modelMetadatasService`
**UX** | Notifications | `toaster`, `ModalService`, `$uibModal`

---

## 6. Edit form (`edit.html`) patterns

Every edit form follows this scaffold. It's what the user sees when clicking the pencil icon on a dashboard cell.

```html
<!-- Copyright start | MIT License | Copyright (c) YYYY Fortinet Inc | Copyright end -->
<form data-ng-submit="save()" name="editMyWidgetForm"
      data-ng-class="{ 'state-wait': processing }" novalidate>

  <div class="modal-header">
    <h3 class="modal-title col-md-9">My Widget — Edit View</h3>
    <button type="button" class="close" data-ng-click="cancel()" aria-label="Close"
            id="close-edit-widget-form-btn">
      <div aria-hidden="true" class="version-button">+</div>
    </button>
  </div>

  <div class="modal-body">

    <!-- Title (every widget has this) -->
    <div class="form-group"
         data-ng-class="{ 'has-error': editMyWidgetForm.title.$invalid &&
                                        editMyWidgetForm.title.$touched }">
      <label for="title" class="control-label">Title</label>
      <input id="title" name="title" type="text" class="form-control"
             data-ng-model="config.title">
    </div>

    <!-- Data source (module selector) -->
    <div class="form-group"
         data-ng-class="{ 'has-error': editMyWidgetForm.resource.$invalid &&
                                        editMyWidgetForm.resource.$touched }">
      <label>Data Source <span class="text-danger">*</span></label>
      <select name="resource" class="form-control"
              data-ng-options="m.type as m.name for m in modules | playbookModules"
              data-ng-model="config.module"
              data-ng-change="loadAttributes()" required>
        <option value="">Select an Option</option>
      </select>
      <div data-cs-messages="editMyWidgetForm.resource"></div>
    </div>

    <!-- Field mapping (repeat per field you need the user to pick) -->
    <div data-ng-if="config.module">
      <div class="form-group">
        <label>Card Title <span class="text-danger">*</span></label>
        <select name="cardTitle" class="form-control"
                data-ng-model="config.mapping.cardTitle"
                data-ng-options="f.name as f.title for f in fieldsArray | orderBy: 'title'"
                required>
          <option value="">Select a field</option>
        </select>
        <div data-cs-messages="editMyWidgetForm.cardTitle"></div>
      </div>

      <!-- Filter builder (drop-in) -->
      <div class="form-group">
        <h6>Filter Criteria</h6>
        <div data-cs-conditional name="filters"
             data-fields="fields"
             data-mode="'queryFilters'"
             data-ng-model="config.query"
             data-enable-nested-filter="true"
             data-enable-expression="(page==='dashboard' || page==='reporting')"
             data-parent-form="editMyWidgetForm"
             data-form-name="'editMyWidgetForm'"></div>
      </div>

      <!-- Sort -->
      <div class="form-group">
        <h6>Default Sort</h6>
        <div data-cs-default-sort name="sortBy"
             data-ng-model="config.query"
             data-fields-array="fieldsArray"></div>
      </div>
    </div>

  </div>

  <div class="modal-footer">
    <button type="submit" class="btn btn-sm btn-primary" id="edit-widget-save">
      <i class="icon icon-check margin-right-sm"></i>Save
    </button>
    <button type="button" class="btn btn-sm btn-default" data-ng-click="cancel()">
      <i class="icon icon-close margin-right-sm"></i>Close
    </button>
  </div>
</form>
```

### 6.1 Validation idioms

```html
<!-- Show red outline when invalid *and* touched -->
<div class="form-group"
     data-ng-class="{ 'has-error': form.field.$invalid && form.field.$touched }">

<!-- Auto-formatted error message (works with required, pattern, min, etc.) -->
<div data-cs-messages="form.field"></div>

<!-- Focus the first invalid input on submit -->
if ($scope.form.$invalid) {
  $scope.form.$setTouched();
  $scope.form.$focusOnFirstError && $scope.form.$focusOnFirstError();
  return;
}
```

### 6.2 Module list filters

- `modules | playbookModules` — excludes system modules the user can't create workflows against.
- `fields | filter: { type: 'picklist' }` — field-type filter.
- `fieldsArray | orderBy: 'title'` — alphabetize the dropdown.

### 6.3 Stubbed edit for "no configuration" widgets

Many drawer/wizard widgets require no user configuration. Use this stub:

```html
<form data-ng-submit="save()" name="editMyWidgetForm" novalidate>
  <div class="modal-header"><h3 class="modal-title">My Widget</h3></div>
  <div class="modal-body">
    <p>This widget does not require a configuration input.</p>
  </div>
  <div class="modal-footer">
    <button type="submit" class="btn btn-sm btn-primary">OK</button>
    <button type="button" class="btn btn-sm btn-default" data-ng-click="cancel()">Close</button>
  </div>
</form>
```

Controller is minimal:

```js
$scope.cancel = () => $uibModalInstance.dismiss('cancel');
$scope.save   = () => $uibModalInstance.close(config || {});
```

---

## 7. View template (`view.html`) patterns

### 7.1 Asset paths

Reference your own assets with the `<name>-<version>` prefix — this is what the platform serves them under:

```html
<link rel="stylesheet" type="text/css"
      href="myWidget-1.0.0/widgetAssets/css/myWidget.css" />

<script src="widgets/installed/myWidget-1.0.0/widgetAssets/js/myWidget.service.js"></script>

<div ng-include="'widgets/installed/myWidget-1.0.0/widgetAssets/html/partial.html'"></div>
```

### 7.2 Widget frame skeleton

```html
<div class="widget-container chart">
  <div class="display-flex-space-between margin-chart">
    <div class="padding-right-0 padding-left-0"
         data-ng-class="(page === 'dashboard' || page === 'reporting')
                         ? 'widget-dashboard-title-width'
                         : 'widget-title-width'">
      <h5 class="padding-left-lg margin-top-0 margin-bottom-0 text-overflow"
          data-ng-if="config.title !== ''">{{ config.title }}</h5>
    </div>
  </div>

  <div class="padding-left-lg padding-bottom-xlg overflow-hidden">
    <div data-ng-if="!processing && records.length > 0">
      <!-- content -->
    </div>
    <div class="watermark"
         data-ng-if="!processing && (!records || records.length === 0)">
      No Records Found
    </div>
    <div class="padding-top-sm padding-bottom-sm" data-ng-if="processing">
      <cs-spinner data-show-background="true"></cs-spinner>
    </div>
  </div>

  <div data-ng-show="!processing && unauthorized" class="unauthorized-message">
    <h6 class="text-center padding-top-lg padding-bottom-lg">
      You do not have necessary permission for {{ config.module | titlecase }}.
    </h6>
  </div>
</div>
```

### 7.3 Rendering a module record's field inline

```html
<!-- Read-only display, honors field type (picklist chip, dates formatted, markdown, HTML-safe) -->
<div data-cs-view-field="record[config.mapping.cardTitle]"></div>

<!-- In a list, with tooltip -->
<div data-uib-tooltip-html="'{{ record[config.mapping.subtitle].value | stripTags }}'"
     data-tooltip-append-to-body="true"
     data-tooltip-placement="top">
  <span data-ng-bind-html="record[config.mapping.subtitle].value"></span>
</div>

<!-- Editable in a record form (fields of interest-style) -->
<div data-cs-editable-field
     data-field="field.fieldData"
     data-mode="'row'"
     data-change-method="notifyFieldChange"></div>
```

### 7.4 Grid

```html
<div class="col-md-12 collection-grid-container margin-top-lg fade-in-animation">
  <div data-cs-grid
       data-grid-options="gridOptions"
       data-paged-collection="pagedCollection"
       class="grid-widget-container"></div>
</div>
```

### 7.5 Chart

```html
<div data-cs-chart="chartOptions"></div>
```

---

## 8. Services catalog

All services below are injected by name (AngularJS DI). Function signatures are from the PDF; behaviours verified against widget source.

### 8.1 Core AngularJS services (pass-through)

Name | Use for
---|---
`$scope`, `$rootScope` | Template bindings, broadcast events
`$http` | Low-level REST calls against FortiSOAR APIs
`$resource` | Higher-level REST wrapper (preferred for `api/3/<module>/:id`)
`$q` | Promises (`$q.defer()`, `$q.all(...)`)
`$timeout`, `$interval` | Deferred execution, polling
`$filter` | Programmatic filter usage: `$filter('getEndPathName')(iri)`
`$state` | UI-Router state + params (`$state.params.module`, `$state.params.id`)
`$window` | Global `window` access (clipboard, open new tab, etc.)
`$uibModal` | Open Bootstrap modals (`$uibModal.open({ ... })`)
`$uibModalInstance` | **Only** in edit/modal controllers — pass config back via `.close(config)`
`$sce` | Sanitize/trust URLs: `$sce.trustAsResourceUrl(iframeUrl)`
`Toaster` / `toaster` | Notifications: `toaster.success({ body: 'OK' })`, `.error`, `.info`, `.warning`
`_` | Underscore.js utility library
`WizardHandler` | Multi-step forms (see §17)
`LocalStorageService` | Persistent key/value store
`PromiseQueue` | Serialize async work: `PromiseQueue.get('picklists')` / `.set(key, promise)`
`Constants` | `API.BASE`, `API.QUERY`, `PLAYBOOK_STEP_TYPES.API_TRIGGER`, etc. (see Appendix A)

### 8.2 FortiSOAR platform services

Name | Purpose | Key functions
---|---|---
`appModulesService` | Load the full module list; map module → UI-Router state | `load(force)`, `getState(module)`, `getListState(type)`
`Common Utils` / `CommonUtils` | Utility helpers | `copyToClipboard`, `generateUUID`, `isBase64Image`, `isJinja`, `isNumber`, `isObject`, `isUUID`, `isUndefined`, `isValidURL`, `parseJSON`, `searchInJSON`, `getIriApiPath`
`connectorService` | Connector management | `getConnector(name, version)`, `getDevelopedConnector`, `executeConnectorAction(name, version, action, configId, payload)`, `updateConnectorConfig`, `deleteConnector`
`currentPermissionsService` | ACL checks | `get()`, `getPermission(module)`, `getPermissions([modules])`, `availablePermission(module, action)`, `availableFieldPermission`, `isAdmin()`
`Entity` | Module metadata & entity persistence | `new Entity(moduleType)`, `loadFields()`, `getFormFields()`, `getFormFieldsArray()`, `getRelationshipFields()`, `get(id, { $relationships: true })`, `save()`, `delete()`, `evaluateAllFields()`, `applyDefaultValues()`, `evaluate()`
`exportService` | Playbook export helpers | `copyEntities`, `downloadJsonFile`, `exportGridRecords`, `getMacrosFromPlaybook`, `getReferencePlaybookForExport`, `loadCollectionNames`, `loadCollectionPlaybooks`, `changePlaybookAndStepsUuid`
`Field` | Single-field model | `evaluateRequired(entity)`, `evaluateVisible(entity)`, `getFormValue()`
`FormEntityService` | Bridge to the parent form's entity | `get()`, `set(entity)`, `submitField(fieldName)`
`licenseService` | License metadata | `getLicenseDetails()`, `getBrandingDetails()`
`modelMetadatasService` | Module metadata store | `loadAllModules`, `getModuleList()`, `getModuleNameByType(type, plural)`, `getIriByType(type)`, `getMetadataByModuleType(type)`, `getTenantModuleList`, `getTenantStagingModule`, `publishTenant`
`Modules` | Wrapper over `$resource` for record CRUD | `new Modules(...)`, `get({ module, id, __selectFields, $relationships })`, `save({ module, $relationships })`
`picklistsService` | Picklist CRUD | `getPicklistByIri(iri)`, `getPicklistByItemValue(fieldName, itemValue)`, `loadAllPicklists()`, `loadPicklistsByParams(name)`
`playbookService` | Playbook metadata & execution | `getPlaybooksData()`, `triggerPlaybookAction($scope, true, entity)`, `detachPaybookStatusWebsocket()`, `getPlaybookExecutionCount(query)`, `getRunningPlaybooks(query)`, `getRunningPlaybookDetails`, `getStepRunningDetails`
`Query` | Build a `queryObject` | `new Query({ sort, limit, logic, filters, aggregates, __selectFields })` → `getQuery(true)` / `getFlatQuery()` / `updateFilter()` / `updateFilters()` / `getQueryModifiers()`
`queryCollectionService` | Load module query collections | `load(moduleName)`, `loadQueryFilterValues`, `loadResource(iri)`
`PagedCollection` | Paginated grid source | `new PagedCollection(module, cfg, extra)`, `.query = new Query(...)`, `loadGridRecord()`, `loadByPost(queryObj)`, `buildSortQuery`, `loadDefaultColumns`, `extendFilter`, `gotoPage`, `pageNext/Prev/First/Last`, `sortColumnsByFieldName`, `convertToKeyPairs`
`settingsService` | Per-user and system settings | `get(key)`, `getSystem()` (cached), `set(key, value)`, `save(key, value)` (depending on host version)
`tokenService` | JWT token management | `get()`, `set(token)`
`usersService` | Current-user helpers | `getAvatar(iri)`, `getCurrentAvatar()`, `getCurrentUser()`, `getUserByIri(iri)`, `loadCurrentUser()`
`ViewTemplateService` | System view templates | `get('app' \| 'dashboard' \| …)`, `changeStructure`, `getConfigInputs`, `getConditionalVisibilityFilteredData`, `populateConditionalFields`
`widgetTemplateService` | Generate widget render metadata | `generateWidgetDefinition(widget)`
`widgetService` | Launch a widget programmatically | `launchStandaloneWidget(name, version, resolveObj?)`
`websocketService` | Channel subscriptions | `subscribe(channel, callback)` → promise resolving to a subscription id; `unsubscribe(id)`

### 8.3 Your own widget-local service

Pattern observed across certified widgets (e.g., `outbreakAlertConfiguration`, `socManagement`, `configureIndicatorExtraction`):

```js
// widgetAssets/js/myWidget.service.js
(function () {
  angular.module('cybersponse').factory('myWidgetService', myWidgetService);
  myWidgetService.$inject = ['$q', '$http', 'API', 'connectorService'];

  function myWidgetService($q, $http, API, connectorService) {
    return { fetchThings, saveThings };

    function fetchThings() {
      return $http.get(API.QUERY + 'my_module').then(r => r.data['hydra:member']);
    }
    function saveThings(payload) { /* ... */ }
  }
})();
```

Include it by adding a `<script>` tag at the top of your `view.html`.

---

## 9. Directives catalog

All FortiSOAR directives use the `cs-` prefix and the `data-` attribute form (required for HTML5 validation compliance).

### 9.1 `data-cs-field` — dynamic form field renderer

Renders an input bound to any FortiSOAR field definition.

```html
<div data-cs-field="field"
     data-ng-model="value"
     data-mode="'add'"
     data-size="'small'"
     data-use-placeholder="true"
     data-enable-jinja="true"
     data-enable-expression="enableExpression"
     data-change-method="onFieldChange"
     data-blur-method="onFieldBlur"
     data-focus-method="onFieldFocus"
     data-disabled="false"
     data-ignore-editable="true"
     data-allow-add-tag="true"
     data-fields-mapping="fieldsMapping"
     data-form-name="'myForm'"></div>
```

`field` is a `new Field({...})` object — see Appendix B for all `formType` values.

### 9.2 `data-cs-conditional` — filter builder

```html
<div data-cs-conditional
     data-fields="params.fields"          <!-- source: entity.getFormFields()+relationships -->
     data-ng-model="config.query"          <!-- sink: full { filters, logic, sort, limit } -->
     data-mode="'queryFilters'"           <!-- 'queryFilters' | 'trigger' | ... -->
     data-enable-nested-filter="true"
     data-enable-jinja="true"
     data-enable-expression="true"
     data-hide-related-fields="false"
     data-form-name="'myForm'"
     data-parent-form="myForm"
     data-reset-field="params.fields"     <!-- array watched for reset triggers -->
     data-reset-name="['fieldA']"></div>
```

The resulting model is:

```js
config.query = {
  sort: [{ field, direction }],
  limit: 30,
  logic: 'AND',
  filters: [
    { field, operator, value, _value: { display, itemValue, '@id' }, type: 'object' }
  ]
}
```

### 9.3 `data-cs-messages` — inline validation

```html
<div data-cs-messages="myForm.username"></div>
```

Pairs with standard AngularJS `required`, `ng-pattern`, `ng-minlength`.

### 9.4 `data-cs-grid` — ui-grid integration

```html
<div data-cs-grid
     data-grid-options="gridOptions"
     data-column-defs="columnDefs"
     data-paged-collection="pagedCollection"></div>
```

`gridOptions` accepts the usual ui-grid flags plus a `csOptions` bag:

```js
const defaultGridOptions = {
  csOptions: {
    allowAdd: true, addText: 'Add', allowLink: false, allowUnlink: false,
    allowDelete: true, allowClone: true, allowSync: false,
    allowGlobalFilter: true, allowModuleFilter: false, customRecordTypeFilter: false,
    allowDateFilter: false, allowUserFilter: false, allowGridFilter: false,
    allowCardView: false, auditLogView: false, viewType: '',
    allowActions: false, allowPlaybookActions: false,
    bulkButtons: [], showPagination: true,
    searchPlaceholder: 'Search', searchEnable: true,
    cloneRelationshipsByDefault: false, clone: cloneFn,
    contextMenu: contextMenuService.getConfig,
    isRelationship: false, searchMinLength: 0,
    enableSelectMenu: true, enableSavedFilters: true,
    wideSearchBar: false, unlinkButtonText: 'Remove Link',
    isFullScreenMode: false
  },
  rowTemplate: 'app/components/grid/clickableRow.html',
  paginationPageSizes: [5, 10, 30, 50, 100, 250],
  paginationPageSize: 30,
  onRegisterApi: scope._setGridApi,
  enableGrouping: false, enableFiltering: true,
  useExternalFiltering: true, useExternalSorting: true,
  enableGridMenu: true, enableColumnMenus: false,
  enableColumnResizing: true, enableColumnMoving: true,
  enableExpandable: false,
  exporterMenuCsv: false, exporterMenuPdf: false,
  expandableRowHeaderWidth: 0, expandableRowHeaderTitle: null
};
```

### 9.5 `data-cs-chart`

```html
<div data-cs-chart="chartOptions"></div>
```

```js
$scope.chartOptions = {
  wid: CommonUtils.generateUUID(), widgetAlwaysDisplay: true,
  showTabularData: false, aggregate: true, assignedToSetting: 'onlyMe',
  chart: 'pie',
  mapping: { assignedToPerson: 'assignedTo', fieldName: 'severity' },
  query: { sort: [...], limit: ..., logic: 'AND', filters: [...], aggregates: [...] },
  resource: 'alerts', title: 'Open Alerts By Severity'
};
```

### 9.6 `data-cs-focus`

Auto-focus on render:

```html
<input type="text" data-ng-model="x" data-cs-focus>
```

### 9.7 `data-cs-card`

```html
<div data-cs-card
     data-ng-model="record"
     data-size="config.size"
     data-mapping="config.mapping"
     data-actions="actions"></div>
```

### 9.8 `data-cs-pagination`

```html
<div class="search-pagination"
     data-cs-pagination data-ng-model="pagedCollection"
     data-ng-hide="pagedCollection.filters.q.length === 0 && pagedCollection.filters.index.length === 0"></div>
```

### 9.9 `data-cs-datetime-grid`

Attaches datetime sort/filter cell on a grid column:

```html
<div data-cs-datetime-grid="::field"></div>
```

### 9.10 `data-cs-tags`

```html
<div class="cs-tags-container">
  <div data-cs-tags="tagsField"
       data-cs-allow-add-tag="false"
       data-change-method="tagsChanged"
       data-ng-model="item.value.tags"
       data-placeholder="tagsPlaceholder"></div>
</div>
```

### 9.11 `data-cs-markdown-editor`

```html
<div data-cs-markdown-editor
     data-mode="'view'"        <!-- 'view' | 'edit' -->
     data-ng-model="task.description"
     data-form-name="'task-' + $index"></div>
```

### 9.12 `cs-spinner`

```html
<cs-spinner data-ng-show="processing" data-show-background="true"></cs-spinner>
```

### 9.13 `data-cs-unique`

Validates the bound value is not present in a list:

```html
<input type="text" data-ng-model="dynamicVariable.name"
       data-cs-unique="dynamicVariablesNameList"
       data-ng-pattern="varRegex" required>
```

### 9.14 Edit-form helpers observed in the wild

- `data-cs-default-sort` — the sort picker shown in most edit modals (`recordCard/edit.html:114`).
- `data-cs-icons` — icon picker.
- `data-cs-view-field` — read-only display of any module field (`recordCard/view.html:19-46` uses similar pattern).
- `data-cs-editable-field` — inline editing (used by `fieldsOfInterest`).
- `cs-connector-field-renderer` — dynamic connector-config form renderer (used by `outbreakAlertConfiguration`, `fortiAIConfiguration`, etc.).
- `cs-typeahead` — people/IRI typeahead (used by `userAssignments`).
- `as-sortable` / `as-sortable-item` / `as-sortable-item-handle` — drag-and-drop lists and kanban (`taskManagement`, `playbookButtons`).
- `ngf-select`, `ngf-drop` — `ng-file-upload` for file attachments (`configureIndicatorExtraction`, `submitContentForm`).

---

## 10. Filters

Filter | Usage | Result
---|---|---
Default Angular filters | `{{ x \| uppercase }}`, `date`, `currency`, `number`, `limitTo`, `orderBy`, `filter` | Stock AngularJS behavior
`getEndPathName` | `$filter('getEndPathName')('/api/3/alerts/80addd07-...')` | `80addd07-...` (UUID from IRI)
`getModuleTypeOfIri` | `$filter('getModuleTypeOfIri')('/api/3/alerts/80addd07-...')` | `alerts`
`isValidIRI` | `$filter('isValidIRI')(value)` | `true`/`false`
`truncateText` | `{{ 'Long...' \| truncateText }}` | Truncates > 55 chars with `...`
`playbookModules` | `modules \| playbookModules` | Filters out non-user modules
`picklistOptions` | `$filter('picklistOptions')(options)` | Only active, orderIndex-sorted picklist items
`unixToDate` | `$filter('unixToDate')(unixSeconds)` | JS Date (used by `slaCountDownClock`)
`stripTags` | `{{ html \| stripTags }}` | Strips HTML tags for tooltips
`titlecase` | `{{ 'alerts' \| titlecase }}` | "Alerts"

Register your own:

```js
angular.module('cybersponse')
  .filter('myCustomFilter', function () {
    return function (input) { return /* ... */; };
  });
```

---

## 11. Querying data

Three ways to talk to the FortiSOAR data plane. **Use `PagedCollection` for lists, `Entity` for single-record work with relationships, and raw `$http.post(API.QUERY + module)` for aggregates.**

### 11.1 `Query` — the query object builder

```js
const q = new Query({
  sort:   [{ field: 'severity.orderIndex', direction: 'ASC' }],
  limit:  2147483647,         // "all"
  logic:  'AND',
  filters: [
    { field: 'severity', operator: 'eq',
      value: '/api/3/picklists/7efa2220-39bb-44e4-961f-ac368776e3b0',
      _value: { display: 'Critical', itemValue: 'Critical',
                '@id': '/api/3/picklists/7efa2220-...' },
      type: 'object' }
  ],
  aggregates: [
    { operator: 'countdistinct', field: '*',              alias: 'total' },
    { operator: 'groupby',       field: 'status.itemValue', alias: 'status' },
    { operator: 'groupby',       field: 'status.color',     alias: 'color' },
    { operator: 'groupby',       field: 'status.orderIndex',alias: 'orderIndex' }
  ],
  __selectFields: ['field1', 'field2']
});

q.getQuery(true);       // plain object ready for $http.post / PagedCollection
q.getFlatQuery();       // flat k=v form for URL
q.updateFilter(newFilterObject);
```

### 11.2 `PagedCollection` — grids & card lists

```js
const coll = new PagedCollection(
  /* module */ $scope.config.module,
  /* columns */ null,                    // optional pre-defined columns
  /* options */ { $limit: $scope.config.query.limit }
);
coll.query = new Query($scope.config.query);

coll.loadGridRecord()                    // GET api/3/<module>?<query>
    .then(() => { $scope.fieldRows = coll.fieldRows; });

// Or for aggregates / custom bodies: POST /api/query/<module>
coll.loadByPost(queryObj);
```

Useful helpers: `gotoPage(n)`, `pageNext`, `pagePrevious`, `pageFirst`, `pageLast`, `setPage`, `sortColumnsByFieldName`, `extendFilter`, `loadDefaultColumns`, `convertToKeyPairs(collection)`.

### 11.3 `Entity` — single records & relationships

```js
const entity = new Entity('alerts');

// Load metadata (needed once per module in an edit form)
entity.loadFields().then(() => {
  $scope.fields      = entity.getFormFields();
  $scope.fieldsArray = entity.getFormFieldsArray();
  // Relationship fields are separate
  angular.extend($scope.fields, entity.getRelationshipFields());
});

// Load an actual record
entity.get($state.params.id, { $relationships: true }).then(() => {
  console.log(entity.fields.severity.value);
  entity.fields.alerts.value;         // array of related records after $relationships=true
});

// Save back
entity.save();
```

### 11.4 `Modules` — direct REST resource

```js
Modules.get({
  module: $state.params.module,
  id: $state.params.id,
  __selectFields: ['severity', 'status']
}).$promise.then(rec => {
  $scope.severity = rec.severity;
});

Modules.save({ module: 'alerts', $relationships: true }, payload).$promise;
```

### 11.5 Raw aggregate via `$http.post`

```js
const queryObj = new Query({ ...cfg }).getQuery(true);
$http.post(API.QUERY + $scope.config.resource, queryObj).then(r => {
  // r.data['hydra:member'] is the array of aggregate rows
});
```

### 11.6 Building an aggregate "group-by-picklist count" query

The most common chart pattern (see `c3Charts`, `funnelChart`, `topX`, `recordDistribution`):

```js
new Query({
  sort:    [{ field: 'total', direction: 'DESC' }],
  filters: config.filters,
  aggregates: [
    { operator: 'countdistinct', field: '*',               alias: 'total' },
    { operator: 'groupby',       field: 'severity.itemValue', alias: 'severity' },
    { operator: 'groupby',       field: 'severity.color',     alias: 'color' }
  ]
}).getQuery(true);
// Response: { 'hydra:member': [ { total: 12, severity: 'Critical', color: '#ff0000' }, ... ] }
```

### 11.7 Operators

`eq`, `neq`, `in`, `nin`, `contains`, `notcontains`, `startswith`, `endswith`, `gt`, `gte`, `lt`, `lte`, `between`, `isnull`, `isnotnull`, `tags_include`, `tags_exclude`. Expression operators supported when `data-enable-expression="true"` (Jinja).

---

## 12. Current record (View Panel context)

Four ways to get the viewed record — pick based on what you need.

### 12.1 `$state.params` (always available on View Panel)

```js
$state.params.module   // 'alerts' | 'incidents' | etc.
$state.params.id       // UUID (NOT the IRI)
```

Use with any loader:

```js
// Via Entity (richest — gives you fields, relationships, helpers)
const e = new Entity($state.params.module);
e.get($state.params.id, { $relationships: true }).then(() => { /* e.fields.* */ });

// Via Modules (leanest)
Modules.get({
  module: $state.params.module,
  id: $state.params.id,
  __selectFields: ['duedate', 'slapaused', 'createDate']
}).$promise.then(r => { /* r.duedate etc. */ });
```

### 12.2 `FormEntityService` (inside a record form, including Add Form)

```js
const entity = FormEntityService.get();
// entity.fields.*, entity.type, etc.
FormEntityService.submitField('description');   // persist a single field
```

Used by `accessControl`, `fieldsOfInterest`, `picklistAsPhases`.

### 12.3 Parent scope (when FortiSOAR nested you inside a record viewer)

```js
$scope.$parent.model    // the raw record object (common on old widgets)
```

### 12.4 Jinja-templated parameters

The platform interpolates widgets' config when rendered through templated routes. `$state.params.qparam` carries a JSON context:

```js
const ctx   = JSON.parse($state.params.qparam);           // e.g. { incident: { id: '...' } }
const resolved = $interpolate(config.entityId)(ctx);       // '{{ incident.id }}' → UUID
```

Used by `incidentCorrelations`, optionally by `incidentTimeline`.

### 12.5 Cross-reference

Widget | Method used
---|---
`fieldsOfInterest`, `picklistAsPhases`, `accessControl` | `FormEntityService.get()`
`recordSummary`, `customPicklistMessage`, `slaCountDownClock`, `vtAugment` | `$state.params.module` + `$state.params.id`
`incidentTimeline` | `$state.params.id` → `new Entity('incidents').get(id, {$relationships: true})`
`recordCard`, `cardTiles`, `cardView` | Not "current record" — they query a module using `config.query`
`incidentCorrelations` | `$state.params.qparam` + `$interpolate`

---

## 13. `config.mapping` convention

Almost every "render-a-module's-fields" widget stores the user's field picks in a `config.mapping` object. The keys are your widget's semantic slots; the values are field *names* (strings).

```js
config.mapping = {
  cardTitle:      'name',
  subtitle:       'description',
  recordIcon:     'logoField',         // Rich-text field containing an <img>
  cardLeftBorder: 'severity',          // Picklist field → borrow its .color
  recordStatus:   'status',            // Picklist for badge
  showIcon:       true,
  cardIcon:       'icon-bell',
  image:          'imageField'
};
```

### 13.1 Select just the mapped fields

```js
// All values (strings) become the __selectFields list
$scope.config.query.__selectFields = _.values($scope.config.mapping);

// Or omit non-field flags
$scope.config.query.__selectFields = _.values(
  _.omit($scope.config.mapping, ['showIcon', 'cardIcon'])
);
```

### 13.2 Read a mapped field on a record

```html
<h4>{{ record[config.mapping.cardTitle].value }}</h4>
<span data-ng-bind-html="record[config.mapping.subtitle].value"></span>
<div data-uib-tooltip-html="'{{ record[config.mapping.subtitle].value | stripTags }}'">...</div>
```

### 13.3 Extract an image from a rich-text field

Rich-text `recordIcon` stores `<p><img src="URL" /></p>`:

```js
let img = item[config.mapping.recordIcon].value
  .replace('<p><img src="', '')
  .replace('" /></p>', '')
  .replace('"></p>', '');
item.image = img;   // bind to <img src="{{ item.image }}">
```

### 13.4 Navigate a nested JSON field

```js
let data = record[config.customModuleField].value;
(config.keyForCustomModule || '').split('.').forEach(k => { data = data[k]; });
```

---

## 14. Theme awareness

```js
const themeId = $rootScope.theme.id;    // 'light' | 'steel' | 'dark'

function setThemeColors() {
  const cfg = {};
  if (themeId === 'light') {
    cfg.background = '#eeeeee';  cfg.border = '#0D9BE3';
  } else if (themeId === 'steel') {
    cfg.background = '#29323e';  cfg.border = '#22a6af';
  } else { // dark (default)
    cfg.background = '#262626';  cfg.border = '#2cafc3';
  }
  return cfg;
}
$scope.colors = setThemeColors();
```

Template:

```html
<div data-ng-style="{'background': colors.background,
                     'border-left': '4px solid ' + colors.border}">
</div>

<!-- Or pick a theme-specific asset -->
<img data-ng-src="myWidget-1.0.0/widgetAssets/images/chevron_{{ themeId }}.svg">
```

When calling external services that need a theme name, **map `steel` → `steel`** (older connectors expect the literal `steel`).

---

## 15. WebSocket subscriptions

Use the websocket to update a widget in real-time when a record or module changes.

```js
function initWebsocket() {
  websocketService
    .subscribe($scope.config.module, onMessage)
    .then(sub => { subscription = sub; });
}
function onMessage(data) {
  // data.changeData is the list of fields that changed
  if (data.changeData.includes(config.watchedField)) reload();
}

$scope.$on('websocket:reconnect', initWebsocket);
$scope.$on('$destroy', () => {
  if (subscription) websocketService.unsubscribe(subscription);
});

initWebsocket();
```

### 15.1 Record-level subscription (View Panel widgets)

```js
websocketService.subscribe(
  `${$state.params.module}/${$state.params.id}`,
  data => { /* reload this specific record */ }
);
```

### 15.2 Relationship subscription

```js
websocketService.subscribe(
  `${$state.params.module}/${$state.params.id}/${relationshipModule}`,
  onRelatedChange
);
```

Observed in: `recordCtaBlock`, `recordSummary`, `customPicklistMessage`, `slaCountDownClock`, `picklistAsPhases`, `multiTableView`, `taskManagement`, `outbreakAlertConfiguration` (for playbook execution).

### 15.3 Playbook status channel

```js
// Subscribe to real-time playbook execution updates
websocketService.subscribe('runningworkflow', data => {
  // data.parent_wf_id, data.task_id, data.status ∈ {'running','failed','finished','finished_error'}
});
```

Used by `playbookExecutionWizard`.

---

## 16. AngularJS events

```js
// Up the scope tree (child → parent → root)
$scope.$emit('fieldChange', $scope.field);

// Down the scope tree (parent → all children)
$scope.$broadcast('updateConfigurationFields', $scope.field);

// App-wide
$rootScope.$broadcast('widget:' + eventName, payload);

// Listen
$scope.$on('fieldChange', (event, field) => { /* ... */ });
```

Events commonly emitted by the platform:

Event | When
---|---
`websocket:reconnect` | Socket re-established after a disconnect. Re-subscribe inside your handler.
`fieldChange` | A `cs-field` value changed.
`updateConfigurationFields` | Configuration field set was refreshed (connector forms).
`csFields:viewValueChange` | A field emitted its `ng-model` change; parent can resync.
`$destroy` | Always clean up (unsubscribe websockets, destroy chart instances, cancel intervals).

---

## 17. Wizards (`WizardHandler`)

```html
<wizard name="mySetupWizard" on-finish="finishedSetup()">
  <wz-step title="Step 1" can-exit="validateStep1">
    <!-- content -->
    <button type="button" wz-next>Next</button>
  </wz-step>

  <wz-step title="Step 2">
    <button type="button" wz-previous>Back</button>
    <button type="button" wz-next>Next</button>
  </wz-step>

  <wz-step title="Finish">
    <button type="button" wz-finish>Finish</button>
  </wz-step>
</wizard>
```

```js
WizardHandler.wizard('mySetupWizard').goTo(2);   // jump to step by index or title
WizardHandler.wizard('mySetupWizard').next();
WizardHandler.wizard('mySetupWizard').currentStep();
```

Many configuration widgets (`outbreakAlertConfiguration`, `fortiAIConfiguration`, `threatIntelManagementConfiguration`, `configureIndicatorExtraction`, `outbreak-response-framework-configuration-wizard`) use 3-6 `wz-step`s, often embedding `connectorConfig.html` via `ng-include` to render connector-specific form fields.

---

## 18. Drawer / non-modal widgets

A widget becomes a floating "drawer" icon (like FortiAI / Setup Guide) when:

```jsonc
"metadata": {
  "pages": [],
  "contexts": ["drawer"],
  "standalone": true,
  "windowClass": "Half Width",
  "view": {
    "popup": "custom",          // Interactive background (non-blocking)
    "draggable": true,          // User can drag the panel
    "activeBackground": true,
    "displayName": "FortiAI",   // Optional — shown next to logo
    "enableFor": [              // Where the drawer icon appears
      "main.dashboard",
      "viewPanel.modulesDetail",
      "main.playbookDetail",
      "main.modules.list"
    ]
  }
}
```

Without `popup: "custom"` the widget opens with a blurred/blocking background (classic modal behavior). `draggable` only has effect when `popup` is `"custom"`.

### 18.1 Drawer lifecycle hooks

The platform fires two extra events to a drawer controller:

```js
$scope.$on('popupOpened', () => { /* refresh, start polling, etc. */ });
$scope.$on('popupClosed', () => { /* pause timers, cancel pending requests */ });
```

Examples: `aiAssistant-4.0.1`, `playbookDeveloperAssistant-1.0.0`.

> **⚠️ Detect host-record context on events, NOT once at boot.** A drawer widget
> is **not torn down on navigation** — its controller/scope stay alive while the
> user moves between pages (§18.4). So reading the current record only in the
> controller constructor is a bug: at construct time `$state` may still be on the
> page you opened *from* (e.g. a module **list**), and the host record is **not**
> reliably on `$scope`. If you then navigate to a record **detail** page, your
> cached context is stale/empty and anything you send upstream goes out with no
> record. (Live regression: the FSR Playbook Builder triage drawer sent
> "Investigate this alert" with no `entity` block because it detected context
> once at boot.) The fix — re-derive on the drawer lifecycle:
>
> ```js
> // Re-detect when the drawer opens AND on every navigation while mounted.
> $scope.$on('popupOpened', _refreshContext);
> $scope.$on('$stateChangeSuccess', _refreshContext);
>
> function _refreshContext() {
>     // $state.params is now settled — read module/id off it.
>     var module = $state.params.module, id = $state.params.id;
>     if (!module || !id) return;                 // list/dashboard — keep last context
>     // Load the record authoritatively (same source the native drawer reads).
>     var entity = FormEntityService.get();
>     entity.loadFields().then(() => { /* update scope context, re-seed */ });
> }
> ```
>
> Guard the refresh on "no record ⇒ return early" so navigating back to a list
> doesn't *strip* a context you already have, and gate any auto-seed on an empty
> conversation so an in-progress chat isn't clobbered. `fortisocchatagent` is the
> canonical reference (`_updateContextFromState` + `_registerStateListener`);
> `fsrPlaybookBuilder`'s `_refreshEntityContext` follows the same shape.
>
> **⚠️ The `popupOpened`/`$stateChangeSuccess` hooks are NOT enough on their own —
> also re-detect in the init `$timeout`.** Opening a drawer *directly onto* a
> record detail (e.g. clicking a case and the drawer mounts as part of the same
> navigation) can settle `$state` onto the detail *between* controller
> construction and the first digest, with **no** further `$stateChangeSuccess`
> broadcast reaching the live scope. If your one-time boot detect (line-1 of the
> ctor) ran on the still-empty `$state`, and your init/seed `$timeout` trusts that
> captured-null context, the summary/seed **never appears until the user
> navigates away and back** (which finally fires a nav event). Live regression:
> `fsrPlaybookBuilder` 1.0.47 → the record-summary card was missing on a case
> until the analyst backed out to an incident detail and reopened the case. Fix
> (1.0.48): in the init `$timeout`, **re-run the detect** before seeding, and if
> it's still empty (state mid-transition at `$timeout(0)`), schedule one short
> retry (~300 ms) that calls `_refreshEntityContext`:
>
> ```js
> $timeout(function () {
>     if ($scope.messages.length > 0) return;
>     if (!($scope.entityContext && $scope.entityContext.iri)) {
>         var re = _detectEntity();
>         if (re && re.iri) $scope.entityContext = re;
>         else $timeout(function () {            // state still settling at t=0
>             if ($scope.messages.length === 0) _refreshEntityContext();
>         }, 300);
>     }
>     /* …chatHistory rehydrate / _seedFromEntity … */
> }, 0);
> ```
>
> Note the side effect: an entity-less mount (true dashboard/list) now schedules a
> stray 300 ms timer — harmless, but tests that assert "no pending `$timeout`
> tasks" via `expect(()=>$timeout.flush()).toThrow()` will break; assert the real
> intent (e.g. `pollSpy` not called) instead.

### 18.2 Multi-context drawer

```jsonc
"contexts": ["drawer", "pb_designer"]
```

Shows the widget in the general drawer rail **and** as a tool inside the Playbook Designer toolbar.

### 18.3 Header / boot context

```jsonc
"contexts": ["header_navbar", "launch_on_boot"]
```

Used by `setupGuide` — adds an icon to the top bar and auto-launches on first login.

### 18.4 How `enableFor` actually works (and what state names mean)

`metadata.view.enableFor` is the **only mechanism** that lets a widget render on a SOAR page that isn't one of the marketplace wizard's five hardcoded `pages` values (`View Panel`, `Dashboard`, `Reports`, `Listing`, `Add Form`). It is read by the `csDrawerWidgetGroup` directive (`fsr_src/app.unmin.js:26220–26236`).

On every Angular UI-Router `$stateChangeSuccess`, the directive walks every drawer widget and toggles `metadata.drawerVisibility` based on whether `$state.current.name` appears in that widget's `enableFor` array. Empty/missing `enableFor` ⇒ always visible.

**The state-name format.** SOAR uses Angular UI-Router with dot-separated parent/child state names:

- `main` is the post-auth app shell (`app.unmin.js:46127`). Sticky state, mounts `app/templates/main.html` into the `content` view, deep-redirects to `main.dashboard`. Every authenticated page is a child.
- `main.playbookDetail` (`app.unmin.js:32540`) — URL `/playbooks/:id`, controller `PlaybookDesignerCtrl`, template `app/playbooks/designer/designer.html`. The playbook editor.
- Other useful child states visible in the bundle: `main.dashboard`, `main.editor`, `main.workflow`, `main.rules`, `main.search`, `main.security`, `main.profile`, `main.system`. To enumerate, grep `app.unmin.js` for `.state("main.`.

**The matcher uses `_.contains` on the exact `current.name`** — so `main.playbookDetail.subview` does **not** match `main.playbookDetail`. List each nested state explicitly.

### 18.5 Capabilities this unlocks

Drawer widgets are the most general extension primitive in SOAR. A few things that follow:

- **Target any UI-Router state, not just the five "pages".** Workflow editor, rule editor, system-settings — anywhere SOAR has a state, you can scope a widget to it. The marketplace wizard's pages list is just the dashboard-picker UX; `enableFor` ignores it.
- **Persistent floating tools across navigation.** Drawer widgets aren't torn down on route change — they keep their controller/scope alive and just toggle visibility. So a Jinja editor with `enableFor: ["main.playbookDetail", "main.editor"]` stays open with its template/input intact while the user flips between records and playbooks. Not achievable with a normal page widget.
- **Cross-page context via the `payload` binding.** `csDrawerWidgetGroup` passes a `payload` two-way binding into each widget. Combined with walking `$rootScope.record` (current viewpanel record) or reading `$state.params`, the drawer widget can react to whatever the user is currently looking at *behind* the popup.
- **Popup event bus.** `$broadcast("popupOpened", widgetKey)` and `$broadcast("popupClosed", widgetKey)` fire on every drawer-widget open/close (`app.unmin.js:26248`). Widgets can listen to coordinate — e.g. close-self when another opens, refresh on return.
- **Override / wrap SOAR UX without forking.** Because `popup: "custom"` renders into the shared `#custom-modal` as a fixed overlay, a drawer widget can effectively be an alternate UI for any state. Useful for: custom record viewer scoped to one module, debug console only on `main.system`, "convert to Jinja" helper button on the playbook editor.

**Gotchas.**
- Drawer widgets are not picker-installable — they appear in the drawer rail on install and have no "Add to dashboard" UX. There is no edit-modal flow either; per-user config has to live in user prefs, the current record, or hardcoded.
- The drawer rail itself must be enabled by the SOAR shell. It is in standard SOAR, but a customer admin who has hidden it leaves nothing to render into.
- For per-record gating beyond state-name matching (e.g. "only when editing alerts module playbooks"), you still need the drawer widget to mount, then a `$watch` on `$state.params` to hide its UI internally.

The mental shift: **widgets aren't just dashboard tiles** — they're a sanctioned plugin extension point with a stable rendering surface and event bus. The dashboard/listing picker is the documented use; `enableFor` + `popup: "custom"` is the more general primitive.

### 18.6 Streaming chat-drawer gotchas (fsrPlaybookBuilder)

A drawer widget that streams an agentic run (poll a `chat_poll` feed while a
blocking `chat_turn` is in flight) hit four non-obvious failure modes. All four
are now fixed in `fsrPlaybookBuilder` and worth copying:

- **Rebuilding the live preview resets per-tool UI state.** If each poll rebuilds
  `streamingMessage` through the same renderer (`FsrPbRender.buildAssistantMessage`),
  the renderer reseeds every `tool_call`'s `{_open,_inputOpen,_resultOpen}` to
  collapsed — so anything the analyst expanded snaps shut on the next ~700 ms poll.
  Carry the prior preview's expand state forward (`_mergeUiState`, keyed by
  `_toolUseId` with positional fallback) **before** assigning the new preview, and
  make the step `ng-repeat` `track by (ev._toolUseId || $index)` so AngularJS
  doesn't recycle DOM by position.

- **Gateway error bodies leak secrets and overflow the widget.** An nginx 404 / 5xx
  echoes the *request* back — including the live `Authorization: Bearer <JWT>` and
  `Websocket-SessionID`. Never show `err.message` raw: map HTML/4xx/5xx bodies to a
  friendly bounded string, scrub `Bearer`/JWT/token/session before anything is
  stored **or exported** (a downloaded `.md` is a leak vector too), and cap the
  banner CSS (`max-height/overflow/word-break/pre-wrap`).

- **`renderMarkdown` must cover block markdown.** A bold/italic/code/links-only
  mini-parser renders LLM `## headings`, `| pipe tables |`, `---`, and `- lists`
  literally. Parse them escape-first (extract fenced code to placeholders before
  block parsing so `|`/`#` inside code isn't mangled), and keep links restricted to
  root-relative/`http(s)` (no `javascript:`/`data:`).

- **`chat_turn` can't be the sole long-lived request for long agentic runs.** A
  "build" turn is one blocking POST; a >5-min agentic run dies against the ~300 s
  gateway ceiling regardless of streaming quality. Durable answer: trim the re-sent
  prior `tool_result`s (they ride verbatim each turn — ~30 KB of records) and commit
  **poll-to-completion** — when the `chat_poll` `stream_end` frame carries the
  transcript, build a result from it (+ the stream's turn #) and run it through the
  *same* `_handleTurnResult` path as the POST return. For this to be safe the commit
  path must be **idempotent per turn** (`_committedTurns[turn]`, first writer wins)
  and `_handleTurnResult` must treat a fast `{accepted}`-with-no-transcript POST
  reply as a no-op (latch the turn #, keep the stream alive). That combination lets
  the connector return an immediate ack and stream the real work to the terminal —
  no blocking POST, no 300 s ceiling — while sync mode (POST returns the full
  transcript) still works because the duplicate is deduped. In the contract this is
  **2.7.0 "detached mode"**: the widget opts in by sending `detached: true` on the
  live `chat_turn` payload (not `chat_resume`), the connector runs the agent on a
  daemon thread (under uwsgi the per-request `harakiri` ceiling ~5 min SIGKILLs a
  blocking worker, losing the terminal frame), and the terminal `stream_end` frame
  carries the **full** envelope (`transcript`, `turn_id`, `contract_version`,
  `last_assistant_yaml`, `tags`) so it stands in for the blocking return. The ack's
  `stop_reason` is the literal `"accepted"` — detect it (or `accepted:true`) +
  no-transcript as the no-op.

- **The stale-replay race: a concurrent `chat_poll` can be served the PREVIOUS,
  already-terminal turn and commit it as the new one.** The widget starts
  polling the moment it fires `chat_turn` (poll at delay 0), and the connector's
  `chat_turn` does health-check + warmup *before* it writes the new turn's
  `turn_start`. If the first poll wins that race, the feed's "current turn"
  (scoped to `MAX(turn)`) is still the *completed* prior turn — whose
  `stream_end` reports `done:true` with its transcript. The widget commits that
  old transcript as the new turn and the new turn produces nothing (export
  `sess-ei6esw96`: a "build playbook" turn replayed the prior enrichment, same
  `tool_use` ids, `finalYaml:false`). The widget's own `minTurn = _lastTurn + 1`
  frame-gate normally drops it — but **`_lastTurn` stays 0 after a history-open**
  (`_replayTurns` rehydrated turns without advancing it), so `minTurn=1` failed
  to exclude turn 1. Fixes, layered:
  - **Connector (root cause):** `chat_poll`/`read_turn_progress` take a
    `since_turn` fence and return only a turn **strictly greater** than it, so a
    completed prior turn is never served. The widget passes `s.minTurn - 1`.
  - **Widget:** `_replayTurns` advances `_lastTurn` to the rehydrated turn count
    (one assistant transcript == one connector turn; never over-count → never
    hang the next poll).
  - **Widget commit guard (defense-in-depth):** latch `_detachedActive` for the
    in-flight detached turn so `_handleTurnResult` treats **any** synchronous
    return (`!fromPoll`) as an ack and never commits its transcript — only the
    `chat_poll` `stream_end` (tagged `_fromPoll`) may commit; plus an
    `_isStaleReplay` drop of any transcript whose `tool_use` ids are **all**
    already on screen. Set the latch *after* `_startStreaming()` (it calls
    `_stopStreaming`, which clears the flag). NB: the detached `chat_turn`
    *return itself is clean* (`{accepted:true}`, no transcript) — the leak was
    the poll feed, not the ack.

- **The legacy `approval_required` modal must resume by `approval_id`, and the
  `approval_request` event has no `args`.** A tier-3 op (e.g. `push_playbook`)
  routed through the connector's `SuspendedSession` gate ends the turn with
  `stop_reason:"approval_required"` and an `approval_request` transcript event.
  That event carries `{approval_id, tool, tier, preview:{tool,args}, args_hash,
  summary, requires_step_up}` — **no top-level `args` field**. Two traps:
  (1) Rendering `ar.args` in the dialog always shows an empty `{}` (the field
  doesn't exist); show `ar.summary`, falling back to a non-empty `ar.preview.args`
  or a plain explanation. (2) The connector's `chat_resume` pops the suspended
  session **by `approval_id`** (`_resume_suspended` → re-enters the provider loop
  with `_approved:True` so the op actually executes). Resuming with only
  `turn_id` falls through to the generic *conversational* resume, the op never
  runs, no playbook is created, and the turn dead-ends ("stuck after Approve").
  Always send `approval_id` on the resume payload. (`preview.args` for
  `push_playbook` is itself `{}` because the compiled YAML isn't echoed into the
  preview — the full args live server-side in the `SuspendedSession`.) This is
  distinct from the `action_card` path, which resumes by `card_id`.

- **A detached turn commits ONLY via the poll terminal, so EVERY poll-teardown
  path must guarantee `viewState` leaves `'sending'` — else the composer hangs on
  the typing bubbles.** In detached mode the `chat_turn` ack carries no
  transcript, so the turn is committed exclusively by the `chat_poll` `stream_end`
  frame (`_fromPoll`). Each way `_pollOnce` can call `_stopStreaming()` *without*
  committing then strands `viewState==='sending'` forever (ng-if of the
  `typing-indicator`) — the exact "click Build playbook → just see the chat
  bubbles" report. The four strand paths and the fix (`_settleDetachedIfStranded`,
  a single chokepoint that degrade-commits the streamed `s.frames` as an
  `end_turn`, or surfaces an error — no-op once committed or in non-detached mode
  where the blocking return is still authoritative):
  - **Signal-only terminal** — `stream_end` with `done:true` but **no transcript**
    (`_absorbPoll`'s "defer to chat_turn return" branch). In detached mode there
    *is* no blocking return to defer to → settle (degrade-commit the frames).
  - **Lost producer / never-terminal** — `chat_poll` is unreachable or `done`
    never flips, so the loop polls forever. The connector's own lost-producer
    guard (writes an error terminal after `STREAM_TIMEOUT_SECS=300`) doesn't help
    if `chat_poll` itself is down. Add a widget wall-clock watchdog
    (`DETACHED_WATCHDOG_MS`, default 6 min, `config.detachedTimeoutMs` override)
    that settles with an error past the cap.
  - **Capability gate / unknown-op** — `chat_poll` answers below `STREAM_MIN_CONTRACT`
    or rejects as an unknown op. The old code set `s.supported=false` and "degraded
    to the blocking response" — but a *detached* turn has no blocking response, so
    that degrade silently hung. Settle with an error.
  - **Render throw during commit** — if `_appendAssistantMessage`/`buildAssistantMessage`
    throws (e.g. a `tool_result` with `null` content — `JSON.stringify(undefined)`
    returns `undefined`, then `.length` throws), the poll `.then` rejects into a
    `.catch` that sees the stream already stopped and bails → strand. Hardened the
    renderer to coerce `tool_result` content to a string, and the settle helper is
    wrapped in try/catch that forces an error state as a last resort.
  Mock-mode turns are synchronous (return the full transcript inline, write no
  feed) so **none of the mock e2e specs exercise this path** — the live detached
  poll loop had zero frontend coverage. Probe it by forcing `?mode=live` and
  `page.route`-stubbing the connector HTTP layer (`POST /api/integration/execute/`,
  `GET /api/integration/connectors/`) to script the detached contract: ack →
  `turn_start` → frames → terminal. See `fsrPlaybookBuilder.liveDetached.spec.js`.
  Two gotchas building that probe: Playwright **regex** route patterns match here
  where `**/…` glob strings silently don't; and the `__fsrPlaybookBuilder__` test
  probe was previously exposed only in mock mode — broadened to any harness
  (localhost) mount so live-path state is introspectable.

- **The build-vs-triage UI mode is NOT on the wire, so a refresh-rehydrate must
  RECONSTRUCT it from the transcript — otherwise an already-built playbook comes
  back hidden.** `chat_history` returns only `{user}` / `{transcript}` turns; the
  `uiIntent` the analyst was in (and `currentYaml`, `playbookLink`) is pure client
  state that a reload drops. On a record-mounted drawer `uiIntent` defaults to
  `'triage'`, and the YAML pane + the `▦ Show/Hide YAML` toggle + the `✚ Create`
  shortcut are all gated on `uiIntent !== 'triage'` (`hasYamlPane()`), while the
  "Ready to automate this?" handoff CTA is gated on `uiIntent === 'triage'`
  (`canBuildFromTriage()`). So after building a playbook and refreshing, the
  analyst saw: no YAML toggle, no created-playbook link, and a confusing
  "Build playbook" CTA re-offering work already done (export `sess-rur4yvdd`).
  Fix in `_replayTurns` → `_rehydrateBuildState()`:
  - **Scan ALL assistant turns for the last `​```yaml` fence, not just the last
    transcript.** A later push/confirm turn carries no fence, so the old
    `_extractYaml(_lastTranscript())` missed an earlier draft. Worse,
    `_lastTranscript()` mapped committed text events to `{text: e.display}` — but
    committed text events store the body on **`.text`** (`{type:'text', text}`),
    so `.display` was `undefined` and YAML never restored at all on reload. Read
    `ev.text` off the committed events directly and `_lastTranscript()` is gone.
  - **Restore `playbookLink`/`playbookName` from a persisted `playbook_pushed`
    `info_card`.** The offer-accept path (`_resume_playbook_offer_accept`)
    persists that card (with a `kind:'link'` block) into the transcript, so the
    "Open in Playbook Designer" link survives a refresh — but the *client* push
    path (`pushPlaybook` → `_appendSystemMessage`) only writes a live system
    message that is NOT persisted, so that link is still lost on reload (would
    need a connector-side transcript-persist on `push_playbook` to fix durably).
  - **Flip `uiIntent` to `'build'` when YAML or a pushed card is present**, so the
    pane/toggle render and the redundant build-from-triage CTA is suppressed. A
    plain triage session (no YAML) correctly stays in triage. Drive the path in
    e2e via the test-only `__fsrPlaybookBuilder__.replayTurns(turns)` probe
    (`fsrPlaybookBuilder.rehydrateBuild.spec.js`); note `link` is a real
    `normalizeBlocks` kind — the render-pipeline fixture validator's `BLOCK_KINDS`
    set was missing it.

---

## 19. Triggering playbooks

### 19.1 From a button widget (contextual to a record)

```js
playbookService.triggerPlaybookAction($scope, /* fromWidget */ true, $scope.entity);
```

`$scope.entity` is typically pulled from `FormEntityService.get()`.

### 19.2 Attach to running-playbook websocket and clean up

```js
// In view.controller.js (buttons widget)
$scope.$on('$destroy', () => {
  playbookService.detachPaybookStatusWebsocket();
});
```

### 19.3 Direct trigger (action trigger endpoint)

```js
// API.ACTION_TRIGGER = 'api/triggers/1/action/'
$http.post(API.ACTION_TRIGGER + playbookUuid, { recordIri: ['/api/3/alerts/<id>'] });
```

### 19.4 Conditional button display

Most button widgets evaluate each playbook's `displayConditions` (a `Query`-compatible filter) against the current record to decide which buttons to show. See `playbookButtons-1.1.1/view.controller.js:96-110`.

### 19.5 Exec wizard integration

```js
widgetService.launchStandaloneWidget('playbookExecutionWizard', '1.0.1', {
  // anything passed here is injectable into the launched controller as `$resolve`
});
```

---

## 20. Connectors

### 20.1 Module-metadata lookup → connector call

```js
modelMetadatasService.getMetadataByModuleType($scope.config.module).then(meta => {
  if (!meta.dataSource) return;                 // no connector integration
  const { connector, action } = meta.dataSource;
  connectorService.executeConnectorAction(
    connector.name, connector.version,
    action.operation,
    connector.configId,
    /* payload */ { indicator: iocValue }
  ).then(r => { $scope.data = r.data; });
});
```

Used by `speedometer`, `categoricalInsights`, `killchainphases`, `customTags`, `vtAugment`.

### 20.2 Managing connector configurations

```js
connectorService.getConnector(name, version).then(c => { /* c.data */ });
connectorService.getDevelopedConnector(name, version);
connectorService.updateConnectorConfig(name, version, configPayload);
connectorService.deleteConnector(id);
```

### 20.3 Agent-based connectors

If a connector runs on an agent, `executeConnectorAction` returns a job id; listen for its result on the websocket:

```js
websocketService.subscribe('runningworkflow', data => {
  if (data.task_id === myJobId && data.status === 'finished') { /* ... */ }
});
```

---

## 21. Permissions

```js
// Full permission bag for a module
const p = currentPermissionsService.getPermission('alerts');
// { read: true, update: true, delete: false, create: true, ... }

// Shortcut for a single action
if (currentPermissionsService.availablePermission('rules', 'read')) { /* ... */ }

// Field-level
currentPermissionsService.availableFieldPermission('alerts', 'severity', 'read');

// Admin?
if (currentPermissionsService.isAdmin()) { /* ... */ }
```

Always guard the view with an `unauthorized` branch:

```html
<div data-ng-if="unauthorized" class="unauthorized-message">
  <h6>You do not have necessary permission for {{ config.module | titlecase }}.</h6>
</div>
```

---

## 22. External assets

### 22.1 Bundled — ship inside the `.tgz`

```html
<script src="widgets/installed/myWidget-1.0.0/widgetAssets/js/lib.js"></script>
<link rel="stylesheet"
      href="widgets/installed/myWidget-1.0.0/widgetAssets/css/style.css">
```

### 22.2 CDN — loaded on demand

```js
function loadJsAsync(src) {
  const d = $q.defer();
  const s = document.createElement('script');
  s.type = 'text/javascript';
  s.src = src;
  s.onload  = () => d.resolve();
  s.onerror = () => d.reject('Failed: ' + src);
  document.head.appendChild(s);
  return d.promise;
}

const scripts = [
  'https://cdnjs.cloudflare.com/ajax/libs/d3-sankey/0.12.3/d3-sankey.min.js',
  'https://unpkg.com/@hpcc-js/wasm@0.3.11/dist/index.min.js'
];
await $q.all(scripts.map(loadJsAsync));
```

### 22.3 Watch out: AMD conflicts

If you load a UMD library that registers itself through AMD (`d3-sankey`, `c3`), temporarily disable AMD:

```js
const amd = window.define && window.define.amd;
if (amd) delete window.define.amd;
loadJsAsync(url).finally(() => { if (amd) window.define.amd = amd; });
```

(Pattern used by `socOverviewSankey-2.1.1`.)

### 22.4 Static data files (geojson, SVG, JSON)

Place under `widgetAssets/`; reference via:

```js
$http.get('widgets/installed/myWidget-1.0.0/widgetAssets/country.geojson')
```

---

## 23. Internationalisation (7.5.0+)

The translation helper `widgetUtility.service.js` ships in every localized widget. Copy it verbatim:

```
widgetAssets/
  js/
    widgetUtility.service.js         # Provided by the platform (same file for every widget)
  locales/
    en.json
    fr_fr.json
    ja.json
    ko.json
    zh_cn.json
    zh_tw.json
```

`en.json` is a key tree keyed by the widget name:

```json
{
  "myWidget": {
    "TITLE_DEFAULT": "My Widget",
    "LABEL_SEVERITY": "Severity"
  }
}
```

In the controller:

```js
// Must run before bindings fire.
function _handleTranslations() {
  const widgetNameVersion = widgetUtilityService.getWidgetNameVersion(
    $scope.$resolve && $scope.$resolve.widget,
    $scope.$resolve && $scope.$resolve.widgetBasePath
  );
  if (!widgetNameVersion) return $timeout(() => $scope.cancel());

  widgetUtilityService.checkTranslationMode(widgetNameVersion).then(() => {
    $scope.viewWidgetVars = {
      TITLE_DEFAULT: widgetUtilityService.translate('myWidget.TITLE_DEFAULT'),
      LABEL_SEVERITY: widgetUtilityService.translate('myWidget.LABEL_SEVERITY')
    };
  });
}
```

In the template:

```html
<h5>{{ viewWidgetVars.TITLE_DEFAULT }}</h5>
```

Preview inside Content Hub only works on 7.4.1+ when locales are present.

---

## 24. Widget-to-widget communication

Use `$rootScope.$broadcast` with a namespaced event when two widgets on the same page need to sync (e.g., a tile that emits "user clicked card X" and a chart that filters to X):

```js
// Emitter (widget A)
$rootScope.$broadcast('widget:' + config.broadcastEvent, { recordId });

// Listener (widget B, configured with the same eventName)
$rootScope.$on('widget:' + config.eventName, (evt, payload) => { /* refresh */ });
```

Wire the event name through each widget's edit form so users can pair them up (see `recordSummaryCard`, `funnelChart`, `topX`, `happinessQuotient`).

---

## 25. Recipes

Each recipe below is a self-contained minimum viable widget. Copy, rename controllers per §5, adjust `info.json`, and iterate.

### 25.1 Dashboard aggregate chart

Scenario: group Alerts by Severity, show a pie chart.

**`info.json`**

```jsonc
{ "name": "alertsBySeverity", "title": "Alerts by Severity",
  "subTitle": "Pie chart of open alerts.", "version": "1.0.0",
  "published_date": 1700000000,
  "metadata": { "pages": ["Dashboard", "Reports"], "certified": "No",
                "publisher": "You", "compatibility": ["7.4.1"],
                "description": "..." } }
```

**`view.html`**

```html
<link rel="stylesheet" href="alertsBySeverity-1.0.0/widgetAssets/css/widget.css">
<div class="widget-container">
  <h5 data-ng-if="config.title">{{ config.title }}</h5>
  <div data-ng-if="!processing" data-cs-chart="chartOptions"></div>
  <cs-spinner data-ng-show="processing"></cs-spinner>
</div>
```

**`view.controller.js`**

```js
"use strict";
(function () {
  angular.module("cybersponse").controller("alertsBySeverity100Ctrl", Ctrl);
  Ctrl.$inject = ['$scope', 'config', 'CommonUtils'];
  function Ctrl($scope, config, CommonUtils) {
    $scope.config = config;
    $scope.processing = false;
    $scope.chartOptions = {
      wid: CommonUtils.generateUUID(),
      widgetAlwaysDisplay: true,
      showTabularData: false,
      aggregate: true,
      assignedToSetting: 'onlyMe',
      chart: 'pie',
      mapping: { fieldName: 'severity' },
      resource: 'alerts',
      title: config.title,
      query: {
        sort: [{ field: 'severity.orderIndex', direction: 'ASC' }],
        limit: 2147483647, logic: 'AND',
        filters: config.query && config.query.filters || [],
        aggregates: [
          { operator: 'countdistinct', field: '*',                alias: 'total' },
          { operator: 'groupby',       field: 'severity.itemValue', alias: 'severity' },
          { operator: 'groupby',       field: 'severity.color',     alias: 'color' },
          { operator: 'groupby',       field: 'severity.orderIndex',alias: 'orderIndex' }
        ]
      }
    };
  }
})();
```

**`edit.html`** — title + `cs-conditional` filter builder (see §6 skeleton).
**`edit.controller.js`** — loads modules, fields, closes modal with config.

### 25.2 View-Panel "current record" widget

Scenario: Show a badge derived from one field of the record currently being viewed.

**`info.json`**

```jsonc
{ "name": "myRecordBadge", "version": "1.0.0", ...
  "metadata": { "pages": ["View Panel"], ... } }
```

**`view.controller.js`**

```js
Ctrl.$inject = ['$scope', '$state', 'Modules', 'websocketService'];
function Ctrl($scope, $state, Modules, websocketService) {
  let sub;
  function load() {
    Modules.get({
      module: $state.params.module,
      id: $state.params.id,
      __selectFields: [$scope.config.fieldName]
    }).$promise.then(r => { $scope.value = r[$scope.config.fieldName]; });
  }
  function subscribe() {
    websocketService
      .subscribe(`${$state.params.module}/${$state.params.id}`, () => load())
      .then(s => sub = s);
  }
  $scope.$on('websocket:reconnect', subscribe);
  $scope.$on('$destroy', () => sub && websocketService.unsubscribe(sub));
  load();
  subscribe();
}
```

### 25.3 Record listing widget (cards on View Panel)

Pick a module, filter, list. Reuse `PagedCollection + Query`.

```js
Ctrl.$inject = ['$scope', 'config', 'PagedCollection', 'Query',
                'currentPermissionsService', '_'];
function Ctrl($scope, config, PagedCollection, Query,
              currentPermissionsService, _) {
  $scope.config = config;
  if (!currentPermissionsService.getPermission(config.module).read) {
    $scope.unauthorized = true; return;
  }
  const coll = new PagedCollection(config.module, null,
                                   { $limit: config.query.limit || 10 });
  config.query.__selectFields = _.values(config.mapping);
  coll.query = new Query(config.query);
  $scope.processing = true;
  coll.loadGridRecord()
    .then(() => { $scope.fieldRows = coll.fieldRows; })
    .finally(() => { $scope.processing = false; });
}
```

### 25.4 Drawer (FortiAI-style) widget

**`info.json`** — see §18.

**`view.html`** — standard drawer chrome (search, refresh, content panel). Handle drawer lifecycle:

```js
$scope.$on('popupOpened', refresh);
$scope.$on('popupClosed', cancelInFlight);
```

**`edit.html`** — "no configuration" stub (see §6.3).

### 25.5 Wizard configuration widget

`view.html`:

```html
<wizard name="myWizard" on-finish="complete()">
  <wz-step title="Basics">
    <form name="step1">...</form>
    <button wz-next data-ng-disabled="step1.$invalid">Next</button>
  </wz-step>
  <wz-step title="Connector">
    <div ng-include="'widgets/installed/myWidget-1.0.0/widgetAssets/html/connectorConfig.html'"></div>
  </wz-step>
  <wz-step title="Finish">
    <button wz-finish>Save</button>
  </wz-step>
</wizard>
```

### 25.6 Settings (admin) widget — no edit form

`"pages": ["Listing"]` or `[]`; `edit.html` is a stub. Fetch system state via `$http` / `settingsService`, update via `$resource.update` / `settingsService.set`.

### 25.7 Playbook-button widget

`playbookService.triggerPlaybookAction($scope, true, FormEntityService.get())` wired to a button. Remember to detach the websocket listener on `$destroy`.

### 25.8 Minimum copyright header (apply to EVERY `.js`/`.css`/`.html`)

```
/* Copyright start
   MIT License
   Copyright (c) 2025 Fortinet Inc
   Copyright end */
```

---

## 26. Widget catalog

Concise purpose + pattern tag per certified widget. Use this to find a close cousin before building from scratch.

Widget | Pages / Contexts | Pattern tag | Purpose
---|---|---|---
**accessControl-2.1.0** | `[]` (inline in views) | Record-form | Record owner/team assignment.
**aiAssistant-4.0.1** | drawer, standalone Half Width, `enableFor` list/detail/playbook/marketplace | Drawer, chat | Generative-AI assistant bot.
**besImpactEvaluation-1.0.0** | Dashboard | Connector dashboard | Best Effort Score impact evaluation.
**c3Charts-1.1.0** | Dashboard, Reports | Chart (c3) | Render arbitrary C3 charts from a JSON field.
**cardTiles-1.0.0** | View Panel, Listing | List cards | Card tile list of records w/ delete, search, refresh.
**cardView-1.0.0** | Dashboard, Reports, Listing | List cards + filter | Card view with infinite scroll & filter panel.
**categoricalInsights-1.0.0** | View Panel | Connector breakdown | Distribution bars from connector + API query.
**cicdConfiguration-1.1.1** | `[]` | Wizard | CI/CD source-control config.
**cicdContentImport-1.0.0** | `[]` | Wizard | Import content packs via CI/CD.
**configureIndicatorExtraction-2.0.0** | `[]` | Wizard + file upload | IOC extraction & regex editor.
**connectorHealthMonitor-1.0.0** | Dashboard, Reports, View Panel, Listing | System status | Lists connectors and per-agent health.
**customPicklistMessage-1.1.2** | View Panel | Record banner | Show message based on a picklist value.
**customTags-1.1.0** | Dashboard, View Panel | Connector augment | Threat-intel tag/card display.
**cyberThreatWorldMap-1.0.0** | Dashboard, View Panel, Reports, Listing, Add Form | Map (d3) | IOC geo distribution.
**dataVisualization-1.0.0** | Dashboard, Reports | Chart (echarts) | Sunburst/treemap/bar/line/pie (multi-mode).
**exportTemplateWizard-1.0.0** | View Panel | Modal launcher | Open export-template wizard modal.
**feedConfigurationSettings-2.0.0** | `[]` | Wizard | Threat-intel feed config.
**fieldsOfInterest-1.0.2** | View Panel (size `lg`) | Record form | Show selected fields regardless of visibility constraints.
**fortiAIConfiguration-3.0.0** | `[]` | Wizard | LLM connector setup (5-step).
**fortiguardIocSearch-1.0.0** | Dashboard | Connector search | Search FortiGuard for IOCs.
**funnelChart-1.0.2** | Dashboard, Reports | Chart (svg) | Funnel stages from JSON field or across-modules query.
**globalVisibilityConfiguration-1.0.0** | `[]` | Wizard | Remote-FortiSOAR connector setup.
**gridSummary-1.0.0** | View Panel, Dashboard, Reports, Listing | Grid | Render JSON as ui-grid.
**happinessQuotient-1.0.0** | Dashboard, View Panel, Reports | Animated metric | % as an animated mug.
**incidentCorrelations-2.1.1** | Dashboard, Reports | Graph (vis-net) | Correlation graph with Jinja-resolved incident id.
**incidentTimeline-1.0.1** | View Panel, Reports | Timeline | Vertical timeline of related alerts+indicators.
**jsonToGrid-1.1.0** | View Panel, Listing, Dashboard | Grid + playbook | ui-grid from playbook output; add/delete rows.
**killchainphases-1.1.0** | View Panel | SVG infographic | Phase counts from connector.
**languagePack-2.1.0** | `[]` | Stub | Language-pack availability advertiser.
**manageDatasets-1.0.0** | `[]` | Admin | TAXII dataset CRUD.
**mitreAttackSpread-1.0.2** | Dashboard, View Panel | Matrix tables | MITRE ATT&CK spread of alerts+incidents.
**mobileSettings-2.0.1** | `[]` | Stub | Placeholder for mobile-only config.
**multiTableView-1.0.0** | View Panel | Accordion + 2-way JSON | Edit JSON arrays within a record.
**outbreak-response-framework-configuration-wizard-1.0.0** | `[]` | Wizard | ORF setup (4-step).
**outbreakAlertConfiguration-2.2.1** | `[]` | Wizard + tabs | Threat-hunt tools multi-connector config.
**picklistAsPhases-1.1.0** | View Panel | Record form | Picklist values as a phases chevron.
**playbookButtons-1.1.1** | View Panel | Playbook trigger | Per-playbook record actions w/ conditions.
**playbookDeveloperAssistant-1.0.0** | drawer (Full Width), `pb_designer` | Drawer graph | vis.js playbook reference graph.
**playbookExecutionWizard-1.0.1** | standalone Full Width | Wizard + websocket | Live playbook execution UI.
**recordCard-1.0.1** | Listing, View Panel | List cards | Card tiles with click-through to record detail.
**recordCtaBlock-1.0.1** | View Panel, Listing | List cards + CTA | Cards w/ CTA button & websocket live updates.
**recordDistribution-1.0.5** | Dashboard, View Panel, Reports | Graph (svg) | Force-style graph of records by picklist.
**recordSummary-2.0.0** | View Panel | Record blocks | Time-elapsed / related-count / field blocks.
**recordSummaryCard-1.0.0** | Dashboard | JSON tile | Summary card from JSON field + broadcast events.
**recordSummaryTile-1.0.0** | Dashboard | JSON tile | Small/large tile derived from JSON field.
**roiCalculator-1.0.1** | Dashboard, Reports | Metric | Automation ROI by playbook tags.
**securityPosture-1.0.0** | Dashboard, View Panel | SVG + connector | FortiAnalyzer outbreak posture.
**setupGuide-1.3.0** | `header_navbar`, `launch_on_boot` | Onboarding | Accordion task list, launches other widgets.
**slaCountDownClock-2.0.1** | View Panel | Timer | Count-down/up clock for SLA states.
**socManagement-2.1.2** | Dashboard | Dashboard SVG | SOC KPIs with SVG foreignObject.
**socOverviewSankey-2.1.1** | Dashboard, Reports | Sankey | Cross-module flow diagram.
**speedometer-1.1.0** | View Panel | Gauge | SVG arc gauge of risk/score.
**submitContentForm-1.0.0** | drawer (`marketplace.*`) | Wizard | Upload content to Content Hub.
**taskManagement-2.0.0** | View Panel | Kanban | Swim-lane kanban (drag-drop + websocket).
**taxiiServerConfiguration-1.1.0** | Listing | Admin | Toggle TAXII server, list datasets.
**threatIntelManagementConfiguration-1.1.0** | `[]` | Wizard + tabs | Multi-connector threat-intel config.
**timeSeriesCharts-1.0.0** | Reports, Dashboard, Listing | Chart (c3) | Time-series from custom `time_series_charts` module.
**topX-1.0.0** | Dashboard | Chart | Top 3/5 of a picklist/JSON aggregate.
**userAssignments-2.1.2** | Dashboard, Reports, View Panel, Listing, Add Form | Metric + avatar | Per-user assignment counts.
**vtAugment-1.0.0** | View Panel | iframe enrich | Embedded VT widget for indicator records.

---

## 27. Cheatsheets

### 27.1 "I want to …" → reach for

Goal | Tool
---|---
Count records grouped by a picklist | `$http.post(API.QUERY + module)` with `aggregates: [countdistinct *, groupby picklist.itemValue, groupby picklist.color]`
List records in a grid | `PagedCollection` + `data-cs-grid`
Fetch one record | `Modules.get({ module, id, __selectFields })`
Fetch record + relationships | `new Entity(module).get(id, { $relationships: true })`
Get the viewed record (View Panel) | `$state.params.module` + `$state.params.id`
Get the form's entity (inside a form) | `FormEntityService.get()`
Open a modal | `$uibModal.open({ templateUrl, controller, resolve })`
Navigate to a module record | `$state.go(appModulesService.getState(module), { module, id })`
Render a filter builder | `data-cs-conditional data-mode="'queryFilters'" data-ng-model="config.query"`
Render a dynamic field | `data-cs-field data-ng-model="x" data-field="field"`
Validation error message | `data-cs-messages="form.fieldName"`
Spinner | `<cs-spinner data-ng-show="processing">`
Subscribe to record changes | `websocketService.subscribe(module+'/'+id, cb)`
Fire notification | `toaster.success({ body: 'Saved' })`
Trigger a playbook | `playbookService.triggerPlaybookAction($scope, true, entity)`
Call a connector action | `connectoconnectorServicerService.executeConnectorAction(name, version, action, configId, payload)`
Theme color | `$rootScope.theme.id` ∈ `light | steel | dark`
Translate a key | `widgetUtilityService.translate('widgetName.KEY')`
Launch a drawer widget programmatically | `widgetService.launchStandaloneWidget(name, version, resolveObj)`
Copy to clipboard | `CommonUtils.copyToClipboard(text)`
Generate a UUID | `CommonUtils.generateUUID()`
Get IRI's UUID | `$filter('getEndPathName')(iri)`
Get module type from IRI | `$filter('getModuleTypeOfIri')(iri)`

### 27.2 Route / state cheat sheet

State name | URL-ish | Use for
---|---|---
`main.dashboard` | `/main/dashboard` | Dashboard host
`main.reports` | `/main/reports` | Reports
`main.modules.list` | `/main/modules/<type>` | Module listing
`viewPanel.modulesDetail` | `/main/modules/<type>/<id>` | Record detail
`main.playbookDetail` | `/main/playbooks/<id>` | Playbook designer
`main.marketplace.workspace` | `/main/marketplace/workspace` | Content Hub

### 27.3 Controller DI checklist

- [ ] `$scope`, `config` (always)
- [ ] `$state` (View-Panel widgets)
- [ ] `$rootScope` (theme, broadcasts)
- [ ] `$uibModalInstance` (edit controllers only)
- [ ] `Query` + `PagedCollection` (list widgets)
- [ ] `Entity` + `Modules` (record widgets)
- [ ] `currentPermissionsService` (anything touching module data)
- [ ] `websocketService` (real-time)
- [ ] `widgetUtilityService` (localized widgets)
- [ ] `appModulesService` (edit controllers needing module list)

### 27.4 `info.json` pages → implied features

`pages` includes … | Runtime gets …
---|---
`"View Panel"` | `$state.params.module` + `$state.params.id`, parent form's `FormEntityService`
`"Dashboard"` / `"Reports"` | `page === 'dashboard'/'reporting'` → wide header CSS
`"Listing"` | Module implied by `$state.params.module`, user's current list filter ignored
`"Add Form"` | `FormEntityService.get()` is a partially-populated new entity
`"Settings"` | Admin-only; use `currentPermissionsService.isAdmin()`
`[]` + `contexts: ["drawer"]` | Drawer icon; `popupOpened`/`popupClosed` events

---

## 28. Pitfalls

1. **Wrong controller name.** `name: "fooBar"` + `version: "1.0.0"` must register `fooBar100Ctrl` / `editFooBar100Ctrl`. Mismatched names = silent failure with a blank cell.
2. **Missing `$inject`.** Minification strips parameter names. Without the explicit `$inject` array, the widget breaks in production.
3. **Missing copyright header.** Content Hub submission linter rejects files without the MIT block.
4. **Forgetting `data-` prefixes.** Raw `cs-field` often works in dev but some HTML parsers strip unknown attributes — always use `data-cs-*`.
5. **Absolute CSS paths.** Using `/widgetAssets/...` breaks when the platform mounts under a sub-path. Always use relative or `widgets/installed/<name>-<version>/...`.
6. **Destroying charts / websockets on `$destroy`.** Omit this and you leak across dashboard refreshes. `chart.destroy()`, `websocketService.unsubscribe`, `$interval.cancel`.
7. **Theme map uses three IDs.** `light`, `steel`, `dark`. Don't branch on just light/dark.
8. **`published_date` type drift.** Unix seconds. Integers are preferred; strings work but some tooling sorts them lexicographically.
9. **`subTitle` vs `subtitle`.** Capital T.
10. **AMD conflict on CDN libs.** d3-sankey, c3, cytoscape all detect AMD and refuse to attach to `window`. Temporarily null out `window.define.amd`.
11. **`__selectFields` is essential for big modules.** Without it every record comes back with its full payload — your dashboard will crawl.
12. **Using `$state.params.id` for an IRI.** It's a UUID. Build IRIs with `/api/3/<module>/<id>`.
13. **Relying on the widget to run on every page.** The platform caches config. Write the controller idempotently — re-entry must reset `processing`, unsubscribe old websockets, and destroy old chart instances.
14. **Stale file permissions in the tarball.** Content Hub rejects files not readable by other. Run `chmod -R a+r .` before packing.
15. **Missing `compatibility` entry for the target version.** If `compatibility` doesn't list the user's FortiSOAR version, Content Hub won't let them install it.
16. **Drawer widgets need `standalone: true`.** Without it the modal renders but can't be launched from the drawer rail.
17. **Localized widgets before 7.4.1.** Preview is silently broken in older versions — degrade gracefully by falling back to English on translation errors.
18. **Validation bypass.** Remember to `$setTouched()` and return early in `save()` when `$invalid`; otherwise users submit empty configs.
19. **Circular `$broadcast`.** Widgets broadcasting events on `$rootScope` can cascade into infinite loops if two widgets subscribe to each other's events with the same namespace.
20. **Connector calls without `configId`.** `executeConnectorAction` silently picks a random config if you pass `null`. Always resolve the config first.

---

## 29. Platform source references (host UI code)

FortiSOAR's web UI ships as a pre-bundled AngularJS app at `/opt/cyops-ui/` on the server. Two files hold everything you'd want to learn from:

| File | What's inside | Size |
|---|---|---|
| `app.unmin.js` | Every module, directive, controller, service, factory, filter, constant. Unminified — variable names still mangled (`a`, `e`, `i`, …) but structure is readable. | ~3.5 MB |
| `templates.min.<hash>.js` | Every HTML template packed as `$templateCache.put('path', '<html>')` entries. | ~2.6 MB |

Both files live at the repo root of this project (pulled from an install). Their content is **not installable** — this is reference material. Use it to mimic look-and-feel in widgets and to find scope contracts for built-in directives.

### 29.1 `templates-extracted/` — unpacked UI templates

**606 HTML files** extracted via `extract-templates.js` (in repo root), preserving the original `$templateCache` paths as directories. Run or re-run with:

```bash
node extract-templates.js                                    # defaults: templates.min.*.js → templates-extracted/
npx prettier --write 'templates-extracted/**/*.html'         # optional: pretty-print all
```

#### Top-level tree (most useful for widget work)

```
templates-extracted/app/
├── admin/               # Admin settings pages (users, roles, teams, SAML, tenants)
├── authentication/      # Login, forgot-password, SSO flows
├── collections/         # Playbook collections
├── components/          # ← All reusable UI widgets — start here
├── connector/           # Connector manager (list, configure, health)
├── customReporting/     # Report builder
├── dataIngestion/       # Threat-intel feed ingestion
├── editor/              # Picklist editor, SVT editor, module editor
├── errors/              # Error pages
├── global/              # App-shell, global modals
├── marketplace/         # Content Hub
├── multitenancy/        # MSSP tenant UI
├── playbooks/           # Playbook designer, step configs
├── queue/, queues/      # Task queues
├── recycleBin/          # Deleted records
├── rules/               # Rule engine
├── scheduler/           # Scheduled playbooks
├── search/              # Global search
├── security/            # Appliance, audit, SSL, backup
├── settings/            # User prefs
├── templates/           # View templates for modules
└── widget/              # Widget-host shell (how widgets mount)
```

#### `templates-extracted/app/components/` — the component library

These 32 folders are the main source of patterns for widgets. Each one corresponds to a `cs*` directive or a reusable controller:

| Folder | What it provides | When you'd copy it |
|---|---|---|
| `avatar/` | User avatar with tooltip | Showing people fields |
| `breadcrumb/` | Record breadcrumb + action buttons | Custom record navigation widgets |
| `chart/` | `cs-chart` template (c3 wrapper) | Any chart widget |
| `codeEditor/` | Monaco / CodeMirror editor templates | JSON/Jinja/Python editors |
| `comments/` | Comment threads, action logs | Comment-aware widgets |
| `connectorActions/` | The "Actions" popover on record detail (4 files) | Custom action launchers |
| `executeBar/` | Bulk-action bar | Grids with bulk ops |
| `exports/` | Export details modal | Custom exporters |
| `file/` | Attachment thumb, upload dropzone | File-handling widgets |
| `form/` | `csEditableField`, `csMessages`, `csJsonFormRow` | Any form widget |
| `fsrMultiSelect/` | Multi-select UI-select wrapper | Typeaheads / multi-pickers |
| `globalDrawer/` | Drawer shell (`drawer` context host) | Reference for drawer widgets |
| `grid/` | `cs-grid`, clickableRow, cardView, filters, expandableRow | Grid/list widgets |
| `header/` | Top navbar (password modal, right panel, app menu) | `header_navbar` context widgets |
| `iframe/` | Sandbox iframe wrapper | Embedded 3rd-party UI (like `vtAugment`) |
| `image/` | Image field renderer | Custom image widgets |
| `jinja/` | Jinja editor, generator, dynamic values/variables | Jinja-aware widgets |
| `jsonformatter/` | Pretty-printed JSON tree | JSON inspectors |
| `jsonutility/` | Json renderer with controls | JSON diff/edit widgets |
| `modals/` | 30+ modal templates (add, import, export, playbook versions, API keys, SSO, etc.) | Opening system modals from widgets |
| `navigation/` | Module nav sidebar | Listing-context widgets |
| `playbooks/` | Step configs, pending decision, manual input, designer | Playbook-interactive widgets |
| `spinner/` | `cs-spinner` | Loading states |
| `timeline/` | `cs-timeline` | Timeline widgets (see `incidentTimeline`) |
| `toasts/` | Toaster notification | Notifications |
| `tooltips/` | Tooltip variants | Rich hover states |
| `ui/` | Generic UI primitives | Buttons, chips |
| `viewTemplates/` | Dynamic form/detail templates | View-Panel widgets |

Quick recipes:

```bash
# Find the template for an observed directive (e.g. the popover you're staring at)
grep -rln 'conn-actions-menu\|loadingConnList' templates-extracted/
# → templates-extracted/app/components/connectorActions/connectorActionListing.html

# Find every modal in the app
ls templates-extracted/app/components/modals/

# Find templates that use a specific scope variable
grep -rln 'ng-model="config\.query"' templates-extracted/
grep -rln 'cs-conditional' templates-extracted/
```

### 29.2 `app.unmin.js` — the platform JS

Not minified, but **variable names are still mangled** (single letters). The `$inject` array at the bottom of each directive/controller is the Rosetta stone.

#### Inventory (mechanical counts from grep)

| Kind | Count | Grep pattern |
|---|---|---|
| `directive("cs*"`) | **122** | `grep -oE 'directive\("[a-zA-Z]+"' app.unmin.js \| sort -u` |
| `controller(...Ctrl`) | **223** | `grep -oE '\.controller\("[a-zA-Z]+Ctrl"' app.unmin.js \| sort -u` |
| `factory(...)` / `service(...)` | **100+** | `grep -oE '\.(factory\|service)\("[a-zA-Z_]+"' app.unmin.js \| sort -u` |
| `filter(...)` | **57** | `grep -oE '\.filter\("[a-zA-Z]+"' app.unmin.js \| sort -u` |
| `constant(...)` | **99** | `grep -oE '\.constant\("[A-Z_]+"' app.unmin.js \| sort -u` |

#### 122 platform directives (all confirmed present)

Read-only sampler (full list is `grep -oE 'directive\("[a-zA-Z]+"' app.unmin.js \| sort -u`):

```
csAttachmentThumb   csAuditLog           csBulkButtons        csBulkLookup
csButtonGroup       csCard               csCardCount          csCardView
csChart             csCodeEditor         csCommentInput       csCompareTo
csCondition         csConditional        csConnectorActions   csConnectorFieldRenderer
csConnectorFields   csCorrelationGraph   csDatetimeCustom     csDatetimeDifference
csDatetimeGrid      csDefaultSort        csDesignerDetail     csDetailTooltip
csDictionary        csDiffTable          csDrawerWidgetGroup  csDynamicList
csEditGridForm      csEditableField      csEmail              csEmailTemplate
csExecuteBar        csFeed               csField              csFieldDropdown
csFieldSelect       csFieldSort          csFile               csFileUpload
csFocus             csGrid               csHtmlEditor         csIcons
csIframe            csImage              csInputVariablesPrompt
csInternationalPhone csJinjaEditorLog    csJinjaGenerator     csJsonEditor
csJsonFormRow       csJsonUtility        csLineItem           csListCount
csMarkdownEditor    csMessages           csMultiselect        csPagination
csPendingDecision   csPercentageLoader   csPhone              csPicklistEditor
csPlaybookActions   csPlaybookDesigner   csQueryHeader        csReadOnlyTagsView
csReferenceCard     csReservedFields     csRightClick         csRightPanel
csRunningPlaybookDesigner csSearchCard    csServerValidator   csSpinner
csStepArguments     csTags               csTimeValidator      csTimeline
csTrigger           csTypeahead          csUnique             csUpdateOwners
csViewField         csViewTemplate       csWebAddressValidator csWidget
csWidgetContent     csWidgetGroup        csWidgetPreview      csWindowTitle
```

**All of these are injectable by attribute in a widget's `view.html`** — they inherit from the parent scope, which means whatever `config`, `$state`, `$rootScope` state you have is visible to them.

#### 100+ factories / services

Platform heavy-hitters (verified present):

```
ActorPagedCollection      AggregateAreaChartBuilder   AggregateBarChartBuilder
AggregatePieChartBuilder  AggregateTimeseriesChartBuilder  AreaChartBuilder
AuditLogPagedCollection   AuthenticationInterceptor   AuthenticationService
BarChartBuilder           BulkUpdate                  ChartBuilder
ChartBuilderFactory       CommonUtils                 ConnectorPagedCollection
Cryptography              DjangoPagedCollection       Entity
Field                     FormEntityService           GatewayPagedCollection
GridSelection             GridUtility                 JsPlumb
LdapSearchPagedCollection ModalService                Modules
PagedCollection           PieChartBuilder             PlaybookConditions
PlaybookDesigner          PromiseQueue                PublishInterceptor
QueueService              RecursionHelper             ReportsPagedCollection
SchedulesService          SearchPagedCollection       StaticPagedCollection
TimeZoneServices          TimeseriesChartBuilder      User
ViewTemplateService       _ (underscore)              appInitializeService
appModulesService         approvalService             auditService
bpmnToPlaybooksService    chartFilter                 chartListService
commentsService           commonService               configurationsService
connectorService          contextMenuService          correlationGraphService
countriesService          currentPermissionsService   fieldEntityDataService
fieldOperatorService      fsrExtensionService         gridColumns
htmlEditorService         iconService                 licenseService
manualInputService        markdownEditorService       marketplaceService
modelMetadatasService     moduleDiffService           nfaService
notificationService       pdfExportService            permissionService
phoneFormat               picklistsService            playbookMappingService
playbookService           playbookVariableService     preProcessingRulesService
Query                     queryCollectionService      queuesService
recommendationService     referenceBlockService       settingsService
sharedUserSettings        stateService                statusCodeService
stepTypeService           teamsService                themesService
tokenService              traitFieldsService          translationLoader
translationService        usersService                versionService
websocketService          widgetService               widgetTemplateService
```

#### Platform filters (57)

The §10 cheatsheet captures the obviously useful ones. Some extras worth knowing exist:

```
arrayToTagCollection   availableModules       availablePages
camelCaseToHuman       connectorFields        convertTagsToVar
convertToCamelCase     convertToLowerCase     convertVarsToTag
countFilter            csSanitizeHTML         dataSharingModules
dateToUnix             dateToUnixInMilliSeconds  dayToDisplay
dayToSeconds           decodeURIFilter        defaultValue
displayLicenseEdition  displayLicenseRole     domPurifySanitize
editNavigationModules  filterFieldsBySearch   filterObject
filterZone             getEndPathName         getKeyFromJinja
getModuleName          getModuleTypeOfIri     getVocabId
hex                    highlightText          humanize
isHexColorLight        isValidIRI             jinjaToTag
multiselectDisplay     numberToDisplay        picklistOptions
playbookFields         playbookModules        playbookModulesFindRecord
preProcessingModules   prependIri             ruleModules
sanitize               splitCamelCase         stripTags
stripTagsWithContent   substract              timeAgoExact
timeStampToExpiry      titlecase              transformSVGLink
truncateText           unixToDate
```

Notable ones missing from §10:

- `prependIri` — `$filter('prependIri')('alerts/abc-123')` → `/api/3/alerts/abc-123`. Saves an `'/api/3/' + module + '/' + id` concatenation (used by `csConnectorActions` on line 52964).
- `availableModules` / `availablePages` — filters module lists by current user's permissions.
- `playbookModules` — the "user modules" filter you've already seen in `edit.html` selectors.
- `picklistOptions` — returns active, `orderIndex`-sorted picklist options.
- `csSanitizeHTML` / `domPurifySanitize` — safer than `ng-bind-html` with `$sce.trustAsHtml`.

#### 99 platform constants

Injectable by name just like services. Examples (full list: `grep -oE '\.constant\("[A-Z_]+"' app.unmin.js | sort -u`):

```
API                         ALL_RECORDS_SIZE        APP_SETTINGS
AGENT_CONFIG_HEALTH         AGENT_TYPE              AGENT_UPDATE_STATE
AUTH_ERRORS                 AUTH_STRATEGIES         BRANDING_FALLBACK
CHANNEL_UUIDS               COMMENT_TYPES           COMMON_CURRENCIES
CONDITIONS                  CONFIG_HEALTH           CONFIG_IMPORT_ORDER
CONFIG_STATUS               CONNECTOR_CATEGORIES    CONNECTOR_FIELD_SUB_TYPE
CONNECTOR_REGEX             CRUD_HUB                CS_USER_TYPE
CURRENT_CONTEXT             CUSTOM_RECORD_TYPES     DEFAULT_DATE_FORMAT
DEFAULT_EXPORT_TEMPLATE     EDITOR_TYPES            EXCLUDED_FIELDS
EXCLUDED_MODULES            FIXED_MODULE            IMAGE_MIME_TYPES_MAP
LICENSE_TYPES               MARKETPLACE             MAX_PLAYBOOK_RECORDS
MAX_RECORD_EXPORT_LIMIT     MAX_TAB_MEMORY          MAX_TEXT_LENGTH
NFA_STATUS                  NFA_TRAITS              PAGE_SIZE
PB_EXEC_LOG_STATUS          PICKLIST                PLAYBOOK_EXECUTION_PRIORITY
PLAYBOOK_STATUS             PLAYBOOK_STEPS_UUID     PLAYBOOK_STEP_TYPES
PLAYBOOK_STEP_TYPES_TRIGGERS PLAYBOOK_STORAGE_TYPES PURGE_PLAYBOOKS
RECORD_TAGS_REGX            REGEX                   REPORT
RESERVED_KEYWORDS           SKIP_JINJA_BRACKETS     SORT_ORDER
SYSTEM_SETTINGS_KEY         SYSTEM_USERS            TAGS
THEMES_TYPES                TIMEZONES               USER_ACCESS_TYPE
UUID_REGX                   VIEW_TEMPLATES          WIDGET_BASE_PATH
WIDGET_CONTEXTS             WIDGET_PAGE_MAPPING     WIDGET_TEMPLATES
```

Three are especially widget-relevant:

- `WIDGET_BASE_PATH` — `{ INSTALLED: 'widgets/installed/' }` — the URL prefix you use when loading widget assets.
- `WIDGET_CONTEXTS` — the platform's master list of legal `contexts[]` values for `info.json`.
- `WIDGET_PAGE_MAPPING` — the master list of legal `pages[]` values (and their internal mapping).
- `ALL_RECORDS_SIZE` — the sentinel limit (e.g. `2147483647`) used when "all records" is wanted.
- `PLAYBOOK_STEP_TYPES` / `PLAYBOOK_STATUS` / `PLAYBOOK_EXECUTION_PRIORITY` — all the magic strings for playbook work.

Dump any one of them:

```bash
grep -A 50 'constant("WIDGET_PAGE_MAPPING"' app.unmin.js | head -60
```

### 29.3 De-minification: reading `app.unmin.js` fluently

The file is structurally readable but identifiers are single letters. Three reliable tricks.

#### Trick 1 — use the `$inject` array as a Rosetta stone

Every controller/directive ends with its `$inject` array. Walk that array left-to-right — the order matches the function parameters inside the directive factory. For `csConnectorActions`:

```js
e.$inject = [
  "connectorService", "_", "CommonUtils", "$filter", "Modules", "toaster",
  "$timeout", "usersService", "$rootScope", "licenseService",
  "FormEntityService", "COMMENT_TYPES", "TAGS", "$q", "websocketService",
  "currentPermissionsService", "Field", "DEFAULT_DATE_FORMAT", "translationService"
];
```

So inside that directive's link function, the single-letter locals (top-down in declaration order) decode as:

```
f → connectorService    g → _ (underscore)     h → CommonUtils      y → $filter
E → Modules            T → toaster            v → $timeout         (next usersService)
b → $rootScope         (licenseService)       C → FormEntityService
D → translationService (constants inlined)    O → $q                P → websocketService
I → currentPermissionsService   R → Field     N → DEFAULT_DATE_FORMAT
```

Cross-reference by reading the **uses** — e.g. `v(function(){...}, 1e3)` is unambiguously `$timeout`. `f.getConfiguredConnectors()` is `connectorService.getConfiguredConnectors()`.

#### Trick 2 — pretty-print once, then symbol-search

```bash
npx prettier --print-width 120 --parser babel --write app.unmin.js
```

This rewrites the file in place with line breaks and indentation. Prettier **does not** rename variables — the single letters stay — but line-per-statement formatting makes the `$inject` array and the directive body visible side-by-side. Pair with WebStorm/VS Code's "Go to Symbol" (Cmd-Shift-O) to jump between directives.

#### Trick 3 — Reserve full-name lookups for things the minifier couldn't touch

Angular DI names, HTML attribute names, and string literals are **never** minified. So these stay greppable:

```bash
grep -n "connectorService\." app.unmin.js | head -20           # all usages of the real-name service
grep -n "getConfiguredConnectors" app.unmin.js                  # method calls survive
grep -n "templateUrl:" app.unmin.js | head -20                 # find every templateUrl → template path
grep -n "'app/components/connectorActions/" app.unmin.js        # template cache keys survive
grep -n '"POST",' app.unmin.js | head                          # all $http POSTs
grep -n 'api/integration/' app.unmin.js | head                 # all calls to a given endpoint
```

### 29.4 Grep recipes (use these first when debugging widget questions)

When a user describes a UI behavior or pastes an HTML snippet:

```bash
# 1. Find the template producing those classes/bindings
grep -rln 'class-or-binding-from-snippet' templates-extracted/

# 2. Find the directive that renders through that template
grep -n "templateUrl.*template-path" app.unmin.js

# 3. Find the scope contract by searching the directive body
grep -n 'directive("csXxx"' app.unmin.js
# then awk that line range

# 4. Find which API endpoints are hit from the feature
grep -n "'api/..." app.unmin.js | grep -i <keyword>

# 5. Find every controller that injects a given service
grep -B 2 '"connectorService"' app.unmin.js | grep -oE '"[A-Z][a-zA-Z]+Ctrl"' | sort -u

# 6. Find where a constant is defined and where it's used
grep -n 'PLAYBOOK_STEP_TYPES' app.unmin.js | head -20
```

When a user asks "how do I replicate X from the platform?":

```bash
# 1. Locate the platform component's files
ls templates-extracted/app/components/<folder>/
grep -n 'directive("cs<Name>"' app.unmin.js

# 2. Read the HTML contract to understand what scope vars it expects
cat templates-extracted/app/components/<folder>/<file>.html

# 3. Read the directive body to understand what services it pulls
awk 'NR>=<dir-start> && NR<=<dir-end>' app.unmin.js

# 4. Look for an existing widget that uses the same service
grep -rln 'connectorService\|modelMetadatasService' widgets-extracted/
```

### 29.5 When to look at platform code vs. widget code

| Question type | Start in |
|---|---|
| "Why does *my* widget render X?" | `widgets-extracted/<yourWidget>/` |
| "How does FortiSOAR's action popover work?" | `templates-extracted/app/components/connectorActions/` → `app.unmin.js` |
| "What's the scope contract of `cs-conditional`?" | `app.unmin.js` — search `directive("csConditional"` |
| "What URL is called when I click Save on X?" | `app.unmin.js` — search the DOM's `ng-click` handler name |
| "Is there a platform filter to format an IRI?" | §10 cheatsheet → full list in 29.2 |
| "Can I open the platform's Import dialog from my widget?" | `templates-extracted/app/components/modals/import.html` + search `"import.html"` in `app.unmin.js` |
| "Does FortiSOAR expose a service for X?" | 29.2 service list + grep `app.unmin.js` for the verb |
| "What's the shape of X's `config`?" | §13 + widgets that use the feature |

### 29.6 Worked example: `csConnectorActions`

Full trace of how the Actions popover on a record works — use this as a template for debugging any platform UI:

```bash
# 1. DOM shows class "conn-actions-menu" + ng-repeat="connector in connectors"
$ grep -rln 'conn-actions-menu' templates-extracted/
templates-extracted/app/components/connectorActions/connectorActionListing.html

# 2. DOM also shows cs-connector-actions attribute → the directive
$ grep -n 'directive("csConnectorActions"' app.unmin.js
53016:  angular.module("cybersponse").directive("csConnectorActions", e), e.$inject = [...]

# 3. Walk back to find where `connectors` is assigned
$ grep -n 'a.connectors\s*=' app.unmin.js
53005:  ...a.connectors = i...
53007:  ...a.connectors = angular.copy(i)...

# 4. Read the $watch — we see `f.getConfiguredConnectors()`
# 5. Find that in the service
$ grep -n 'getConfiguredConnectors' app.unmin.js
# returns the function body showing the HTTP call
```

### 29.7 Safe vs. unsafe coupling

What's **safe** to rely on in widgets:

- Any `factory`/`service` listed in 29.2 — they're the platform's public surface.
- Any `cs*` directive — the `data-cs-*` attributes are the documented contract.
- Constants (`API`, `PLAYBOOK_STEP_TYPES`, etc.).
- Template paths like `app/components/modals/add.html` referenced through platform services (`ModalService.open(...)`).

What's **unsafe** (prefer to avoid, but understand for debugging):

- Minified variable names — they change every release.
- `templateUrl` strings as absolute references in your own code — they can move.
- `$scope.$parent.$parent` chains — fragile across UI-Router state nesting.
- Private-looking helper functions (`_handleSomething`) — unexported internals.

---

## Appendix A — `API` constants

Injected via the `API` / `Constants` provider (see §8.1). Verbatim from the PDF / source.

```js
API.BASE                    = 'api/3/'
API.API_3_BASE              = '/api/3/'
API.TEMPLATE                = 'api/3/template/'
API.WORKFLOW                = 'api/wf/'
API.WORKFLOW_HEALTH         = 'api/wf/workflow/healthcheck/job/'
API.INTEGRATIONS            = 'api/integration/'
API.SEALAB                  = 'wf/'
API.ETL                     = 'gateway/etl/'
API.AUDIT                   = 'api/gateway/audit/'
API.AUTH                    = 'api/auth/'
API.PUBLIC                  = 'api/public/'
API.QUERY                   = 'api/query/'
API.QUERIES                 = 'api/3/queries'
API.REPORTS                 = 'gateway/report/'
API.DAS                     = 'auth/'
API.POSTMAN                 = 'api/postman/'
API.SAML                    = 'api/saml/'
API.SEARCH                  = 'api/search/'
API.ARCHIVAL                = 'api/archival/'
API.PUBLISH                 = 'api/publish'
API.MANUAL_TRIGGER          = 'api/triggers/1/notrigger/'
API.WORKFLOW_STEPS          = 'workflow_steps/'
API.WORKFLOW_GROUPS         = 'workflow_groups/'
API.WORKFLOW_BLOCKS         = 'workflow_blocks/'
API.WORKFLOWS               = 'workflows/'
API.WORKFLOW_ACTION         = 'api/workflows/actions'
API.REVERT                  = 'api/publish/revert'
API.PUBLISH_ERROR           = 'api/publish/error'
API.ACTION_TRIGGER          = 'api/triggers/1/action/'
API.CURRENT_AVATAR          = 'avatars/current/'
API.CURRENT_ACTOR           = 'actors/current/'
API.AUTHENTICATION          = 'authentication/'
API.ROLES_TEAM_READ_ONLY    = 'api/userteam'
API.USER_PREF_PREFIX        = 'user/view/'
API.REMOTE_ACTION_EXECUTION = 'api/integration/remote-action-execution/'
API.API_HMAC_TRIGGER_URL    = 'api/triggers/1/'
API.IMPORT                  = 'api/import/'
API.EXPORT                  = 'api/export/'
API.SYSLOG_CONFIG           = 'api/gateway/config/syslog'
API.API                     = 'api'
API.WEBSOCKET               = 'websocket/cyops-websocket'
API.SYSTEM_MODULES          = 'api/system/fixtures'
API.RULE                    = 'api/rule/'
API.DELETE_WITH_QUERY       = 'api/3/delete-with-query/'
API.EXPORT_TEMPLATES        = 'api/3/export_templates/'
API.SOLUTION_PACKS          = 'api/3/solutionpacks/'
```

Playbook step types (constants):

```js
PLAYBOOK_STEP_TYPES.API_TRIGGER              = 'cybersponse.api_call'
PLAYBOOK_STEP_TYPES.ACTION_TRIGGER           = 'cybersponse.action'
PLAYBOOK_STEP_TYPES.ABSTRACT_TRIGGER         = 'cybersponse.abstract_trigger'
PLAYBOOK_STEP_TYPES.DECISION                 = 'Decision'
PLAYBOOK_STEP_TYPES.MANUAL_DECISION          = 'ManualDecision'
PLAYBOOK_STEP_TYPES.MANUAL_INPUT             = 'ManualInput'
PLAYBOOK_STEP_TYPES.APPROVAL_MANUAL_INPUT    = 'ApprovalManualInput'
PLAYBOOK_STEP_TYPES.SET_VARIABLE             = 'SetVariable'
PLAYBOOK_STEP_TYPES.INSERT_DATA              = 'InsertData'
PLAYBOOK_STEP_TYPES.UPDATE_DATA              = 'UpdateRecord'
PLAYBOOK_STEP_TYPES.REFERENCE_BLOCK          = 'ReferenceBlock'
PLAYBOOK_STEP_TYPES.TRIGGER_REFERENCE_BLOCK  = 'action.reference.block'
PLAYBOOK_STEP_TYPES.POST_DELETE_TRIGGER      = 'cybersponse.post_delete'
PLAYBOOK_STEP_TYPES.PRE_DELETE_TRIGGER       = 'cybersponse.pre_delete'
PLAYBOOK_STEP_TYPES.POST_CREATE_TRIGGER      = 'cybersponse.post_create'
PLAYBOOK_STEP_TYPES.PRE_CREATE_TRIGGER       = 'cybersponse.pre_create'
PLAYBOOK_STEP_TYPES.POST_UPDATE_TRIGGER      = 'cybersponse.post_update'
PLAYBOOK_STEP_TYPES.PRE_UPDATE_TRIGGER       = 'cybersponse.pre_update'
PLAYBOOK_STEP_TYPES.MANUAL_DECISION_STEP_TYPE= '/api/3/workflow_step_types/dc61b68b-4967-4e82-b4ed-a1315aa81998'
PLAYBOOK_STEP_TYPES.MANUAL_INPUT_STEP_TYPE   = '/api/3/workflow_step_types/fc04082a-d7dc-4299-96fb-6837b1baa0fe'
```

---

## Appendix B — Field `formType` values

Supported by the `data-cs-field` directive (from PDF p. 34-36):

`password`, `text`, `checkbox`, `integer`, `checkbox.select`, `decimal`, `datetime`, `Datetime.advance`, `phone`, `email`, `DynamicList`, `multiselect`, `richtext`, `json`, `textarea`, `picklists`, `multiselectpicklist`, `lookup`, `ipv4`, `ipv6`, `domain`, `url`, `tags`.

Field constructor:

```js
const f = new Field({
  name:      'severity',           // Field name as stored on the module
  formType:  'picklists',
  title:     'Severity',
  writeable: true,
  validation: { required: true, pattern: /^.+$/ },
  // For lookups:
  dataSource: { module: 'people', fieldName: 'email' },
  // For picklists:
  picklistName: 'severity'
});
f.evaluateRequired(entity);
f.evaluateVisible(entity);
f.getFormValue();
```

Field-Options (passed via `data-field-options` on `cs-field`):

```js
{
  linky: true,              // Turn URLs into links
  readOnly: false,
  highlightMode: false,
  entity: { module: 'alerts', id: '...' }   // For multiselect lookups
}
```

---

## Building widgets that reuse SOAR's connector-action UI

Notes captured while building `widget-action-renderer`. These apply to any
widget that embeds `cs-connector-field-renderer` or wires up its own
connector → operation → params → run flow.

### Triggering a playbook by API

`playbookService.triggerPlaybookAction({ __uuid, __resource, records })` —
**`__uuid` must be the playbook's UUID, not the record's**. Sending the
record UUID gives `404 /api/triggers/1/action/<uuid>`. `records` is the
list of record IRIs (e.g. `/api/3/alerts/<uuid>`), `__resource` is the
module name. The widget needs to track the result task ID itself if it
wants to poll for the playbook output — `triggerPlaybookAction` only
fires the trigger.

### cs-field placeholder leak in the harness (`{{ ::placeholder }}`)

SOAR's `app/components/form/fields/input.html` template uses interpolation
in attributes (`placeholder="{{ ::placeholder }}"`). Real SOAR ships these
templates pre-compiled into `$templateCache` at build time. When the
harness lets `$templateRequest` fetch the template at runtime, the
one-time `::` bind freezes as literal text in the rendered DOM —
the input shows `{{ ::placeholder }}` verbatim.

**Fix**: pre-load a clean template into `$templateCache` before any
`cs-field` resolves it. Use `data-ng-attr-placeholder="{{placeholder}}"`
instead of the brittle `::` form, and **keep the original `ng-change`
and `ng-blur` bindings** — `ng-change="changeMethod(value, field)"` is
what propagates user input up through `cs-field` →
`cs-connector-field-renderer.onChange` into the parent `params` map.
Drop it and selects look fine but typed text never reaches `config.params`.

```js
// harness.module.js
app.run(["$templateCache", function ($templateCache) {
  var clean = [
    '<div class="display-flex">',
    '  <input type="text" class="form-control"',
    '    data-ng-attr-id="{{formName + \'-\' + field.name}}"',
    '    data-ng-attr-name="{{field.name}}"',
    '    data-ng-model="$parent.value"',
    '    data-ng-required="field.required"',
    '    data-ng-readonly="disabled"',
    '    data-ng-attr-placeholder="{{placeholder}}"',
    '    data-ng-change="changeMethod(value, field)"',
    '    data-ng-blur="blurMethod(value)"',
    '    autocomplete="off" spellcheck="false" />',
    '</div>',
  ].join("");
  $templateCache.put("app/components/form/fields/input.html", clean);
  $templateCache.put("/app/components/form/fields/input.html", clean);
}]);
```

### Text fields render as empty thin bars (the "jinja-tag-view" bug)

The `cs-field` directive's link cycle (`app.unmin.js:9794`) sets
`field.jinjaExpressionView = isJinjaConvertibleToTag(value) || jinjaDefaultView==='edit'`.
For empty values with `enableJinjaToTag=true` and no `jinja-default-view`
attribute, this lands `false` → the field renders the read-only
`.jinja-tag-view-container` div (an empty grey bar) instead of an
`<input>`. Pre-seeding `field.jinjaExpressionView=true` on the field
object is overwritten by the directive's link.

You **cannot** simply pass `data-jinja-default-view="'edit'"` on
`cs-connector-field-renderer` to fix it — `app.unmin.js:9868` checks
`"edit" === jinjaDefaultView && "text" !== field.type` and flips
non-text fields (selects, picklists) into `jinja.input` mode (a text
input with a back-arrow toggle).

**Fix**: re-assert `jinjaExpressionView=true` on text-style field
types *after* the directive's link, via `$timeout`. Re-run on
`csFields:fieldVisibleChange` so onchange-revealed children get the
same treatment.

```js
var TEXT_TYPES = { text:1, password:1, integer:1, number:1, json:1, "jinja.input":1 };
function forceInputView(arr) {
  (arr || []).forEach(function (p) {
    if (p && TEXT_TYPES[p.type]) p.jinjaExpressionView = true;
    if (p && Array.isArray(p.parameters)) forceInputView(p.parameters);
    if (p && p.onchange) Object.keys(p.onchange).forEach(function (k) {
      if (Array.isArray(p.onchange[k])) forceInputView(p.onchange[k]);
    });
  });
}
$timeout(function () { forceInputView($scope.connectorParamFields); }, 50);
$timeout(function () { forceInputView($scope.connectorParamFields); }, 250);
$scope.$on("csFields:fieldVisibleChange", function () {
  $timeout(function () { forceInputView($scope.connectorParamFields); }, 50);
});
```

Also seed each field with a sane `placeholder` (use `description` or
a default), `value=""` (`undefined` blows up
`field.value.includes('resolveVault')` in the input template), and skip
`multiselect/select/checkbox/picklist` when forcing input view.

### cs-field input sizing

SOAR's `form-control` sizing rules sometimes don't reach widget DOM
(theme stylesheet load order). Inputs render as 5-px-tall slivers.
Add a hard CSS guard in the widget's own CSS:

```css
.your-cs-fields-wrapper input.form-control,
.your-cs-fields-wrapper select.form-control,
.your-cs-fields-wrapper textarea.form-control {
  min-height: 32px;
  padding: 6px 10px;
  line-height: 1.4;
}
```

### Auto-growing a textarea that's also filled programmatically

A composer textarea that grows with its content (`height:auto` →
`scrollHeight`) must re-fit on **both** paths: the analyst typing (the
`input` DOM event) **and** code that sets `ng-model` directly (e.g. a
"Case context" / paste-summary button). A programmatic `ng-model` change
does **not** fire `input`, so an `input`-only handler leaves the field
pinned at its one-line height with an internal scrollbar. Use a small
attribute directive that listens to `input` *and* `$watch`es the element's
`.value`:

```js
.directive('fsrPbAutosize', function () {
  return { restrict: 'A', link: function (scope, element) {
    var ta = element[0];
    function fit() { ta.style.height = 'auto';
                     ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; }
    element.on('input', fit);
    scope.$watch(function () { return ta.value; }, fit);  // catches ng-model fills
  }};
})
```
(fsrPlaybookBuilder `view.controller.js`; cap matches the CSS `max-height`.)

### Custom-overlay modals: flex-column to avoid a double scrollbar

A widget-built modal (own `.overlay`/`.panel`, not `$uibModal`) that puts
`overflow:auto` on the whole panel scrolls the header along with the body,
and the panel scrollbar overlaps the rounded corners — visually a *second*
scrollbar next to the host page's. Make the panel a flex column and let
**only the body** scroll:

```css
.panel       { display:flex; flex-direction:column; overflow:hidden; max-height:90%; }
.modal-header,
.modal-footer{ flex:0 0 auto; }
.modal-body  { flex:1 1 auto; min-height:0; overflow-y:auto; }
/* if a <form> wraps header+body+footer, it needs the same flex column + min-height:0 */
```
Also neutralize Bootstrap's `.close` leakage (`float:none; opacity:1;
text-shadow:none`) so the × sits where flex puts it, not floated.
(fsrPlaybookBuilder settings/history/export modals.)

### Hello World connector for tests

The "Hello World" test connector on the SOAR test host registers as
**`hello-world`** (hyphenated), not `hello world`. A regex `/hello world/i`
will not match it; use `/hello[- ]world/i`. Confirmed operations:

| Title         | Param              | Type    | Required |
|---------------|--------------------|---------|----------|
| Say Hello     | name               | text    | yes      |
| Add Numbers   | number_a, number_b | integer | yes      |
| Reverse Text  | input_text         | text    | yes      |

Good baseline for connector-flow integration tests — small, deterministic,
and exercises the text-style param path that breaks first when
`cs-field`/template wiring regresses.

### Driving cs-connector-field-renderer from a test

The directive is gated by an `ng-if` (e.g. `connectorParamFields.length`),
so the element is in the DOM but its **isolate scope only attaches after
the next digest**. Two pitfalls:

1. There can be 2+ `<cs-connector-field-renderer>` elements in DOM (the
   recursive child-template clone is hidden). Use the visible one with
   the `.ng-isolate-scope` class inside your widget-specific wrapper.
2. To exercise the user-typing path without dispatching real DOM input
   events, call the renderer's `onChange(value, field)` directly on its
   isolate scope — that's the same callback `cs-field` invokes from its
   internal `ng-change`. After that, `config.params[field.name]` will
   reflect the value.

```js
await page.waitForFunction(() =>
  !!document.querySelector(".my-wrapper cs-connector-field-renderer.ng-isolate-scope"));
await page.evaluate(() => {
  const el = document.querySelector(".my-wrapper cs-connector-field-renderer.ng-isolate-scope");
  const rsc = window.angular.element(el).isolateScope();
  const target = rsc.jsonData.find(p => p.type === "text");
  rsc.onChange("PROBE_VALUE", target);
  rsc.$apply();
});
```

### Wizard-style edit modals: gating Next/Save

For multi-step edit modals (Source → Params → Run sample → Output) gate
progress on data, not just clicks:

- `canAdvance(step)` returns a boolean per step. For connector params,
  walk `connectorParamFields` recursively and require non-empty `value`
  on every `required && editable && visible !== false` field. Jinja
  expressions count as filled (they resolve at runtime — you can't
  validate them client-side).
- Track `maxStepReached` in `gotoStep()` and refuse `save()` until
  `maxStepReached >= lastStep && canAdvance(1..N-1)`. Otherwise users
  can save with empty required params or an unconfigured Output.
- Bind `data-ng-disabled` on the Next/Save buttons; on premature Save,
  toast + jump back to the first incomplete step instead of silently
  closing.

### Don't put `data-ng-controller` on a SOAR view.html root

SOAR's publish step strips the `Dev` suffix from the controller name
**inside the file** but leaves the `data-ng-controller` attribute alone.
Result: a parallel dead scope (the harness's wrapping ng-controller
works, the inner one doesn't), showing up as text-interpolation that
"should work" silently failing. Wrap with the harness's own
ng-controller; don't add one to the widget template root.

### Test invariants worth pinning

When wiring up integration tests against the harness:

- Assert `audit.literalInDom === 0` for `{{ ::placeholder }}` — catches
  the `$templateCache` regression directly.
- Sweep `[data-cs-field]` rows: if a row has a
  `.jinja-tag-view-container` and **no usable**
  `input/select/textarea`, that's the empty-bar bug — a height check
  alone misses it because the bar is a `<div>`, not an `<input>`.
- Assert at least one input/select has `height >= 20px` (the
  squished-input regression).
- Assert `canAdvance(2) === false` after wiping required values, then
  `=== true` after filling them.
- Assert `canSave() === false` on Step 1, then `=== true` after walking
  to Step N — and that calling `save()` prematurely doesn't close the
  modal.

---

## Adding a custom theme to the SOAR system-settings dropdown

This is a SOAR appliance modification, not a widget — but it's grouped here
because the discovery path uses the same de-min / grep techniques as §29.

### How themes work in SOAR

- The list of selectable themes is a plain JSON registry on the appliance:
  `/opt/cyops-ui/app/settings/themes.json`. Each entry has
  `{id, name, path, type}`. `name` is an i18n key, `path` is the bundled CSS
  file under `css/themes/`, `type` is `dark` or `light` (used by components
  that branch on background luminance).
- `cindex.html` always loads `css/themes/steel.<hash>.css` as a baseline,
  then layers the selected theme on top via
  `<link rel="stylesheet" data-ng-href="{{theme.path}}">`. Switching themes
  just rebinds `theme.path` — no reload required.
- `themesService` (factory in `app.unmin.js` ~ line 45470) loads
  `themes.json`, runs each `name` through `translationService.instantTranslate`,
  caches via `localStorageService` + `PromiseQueue`, and exposes
  `get()` / `applyTheme()`. **There is no filter** — every entry in the JSON
  is shown. The three consumers (`GeneralCtrl` ~42377, `UserCtrl` ~41136,
  `UserPreferenceSettingsCtrl` ~64097) just bind the full array. If a theme
  appears in the JSON but not in the dropdown, it's stale browser/local
  storage cache; hard-refresh and clear local storage.
- Out of the box on 7.6.x, `themes.json` ships **four** themes
  (`dark`, `light`, `steel`/"Space", `deepSea`) even though older builds
  only surfaced three.

### Steps to add your own theme

1. **Copy a stock theme CSS as a starting point** (pick whichever palette
   is closest to what you want):

   ```bash
   sudo cp -p /opt/cyops-ui/css/themes/steel.4f959b81.css \
              /opt/cyops-ui/css/themes/mytheme.css
   ```

   Use an unhashed filename — SOAR upgrades re-hash the stock files but
   leave unknown ones alone.

2. **Edit the colors.** A useful diff to see the surface area:

   ```bash
   diff <(sed 's/#[0-9a-fA-F]\{6\}/X/g' /opt/cyops-ui/css/themes/dark.*.css) \
        <(sed 's/#[0-9a-fA-F]\{6\}/X/g' /opt/cyops-ui/css/themes/steel.*.css)
   ```

   Most differences are color literals; that's what you're retheming.

3. **Register it in `themes.json`:**

   ```bash
   sudo cp -p /opt/cyops-ui/app/settings/themes.json \
              /opt/cyops-ui/app/settings/themes.json.bak
   ```

   Add an entry:

   ```json
   {"id":"mytheme","name":"My Theme","path":"css/themes/mytheme.css","type":"dark"}
   ```

   `name` can be a literal string — angular-translate falls back to the
   key when no locale entry exists. If you want a real translation, add
   `"SETTINGS.GENERAL_CONFIG.THEME_MYTHEME": "My Theme"` to each
   `/opt/cyops-ui/locales/<lang>.json` you care about and use that key in
   `name` instead.

4. **Hard-refresh the browser** (cache + local storage). No `cyops-ui`
   service restart required — `themes.json` is fetched at runtime and
   the CSS is loaded by the `<link>` swap.

5. **Verify** in DevTools: switching to your theme should change the
   `data-ng-href` of the second `<link>` in `<head>` to your CSS path.
   The `<body>` class continues to read `theme-<id>` for components that
   key off it directly (search the CSS for `.theme-steel` to see what
   does).

### Survival across upgrades

A SOAR upgrade rewrites `themes.json` and re-hashes the stock CSS
filenames; your `mytheme.css` survives but the JSON entry is wiped.
Wrap steps 1 and 3 in an idempotent post-upgrade script (check whether
the file/entry already exists before adding) and re-run after each
upgrade.

### Why this is not a widget

There is no widget hook for system-level theming — themes are loaded
before the Angular app's widget system bootstraps. A widget can inject
its own `<link>` and toggle a class on `<body>`, but it can't add an
option to the system-settings dropdown. If you don't have shell access
to the appliance, the widget-injection workaround is the only path; with
shell access, edit `themes.json` directly as above.

---

## Harness gaps from the stripped SOAR bundle

The harness loads `fsr_src/app.unmin.js` (the full SOAR app), but that bundle
has angular-ui-bootstrap and a few sibling vendor modules **stripped out** —
their directive/factory registrations live in separate vendor scripts in real
SOAR. Anything in SOAR templates that depends on those vendors (`uib-popover`,
`uib-tooltip`, `uib-popover-template`, `uib-modal`, `uib-typeahead`, etc.)
silently no-ops in the harness because the directive simply isn't registered.

### Symptom pattern

A SOAR-rendered control looks correct (button labels, placeholders, structure
all there) but **clicking does nothing** — no popover, no dropdown, no modal,
no console error. The directive attribute (`data-uib-popover-template=...`)
sits inert on the element because Angular found no matching directive and
therefore wired up no event handler.

This is distinct from the "literal `{{ ... }}` in the DOM" symptom, which is
caused by translation strings missing param interpolation (see harness
`translate` filter — must call `$interpolate(str)(params)` not just look up
the key).

### Diagnosis

1. `grep -c "directiveName" fsr_src/app.unmin.js` — if matches are only
   *usages* (`uib-popover-template="..."`) and zero *registrations*
   (`directive("uibPopoverTemplate", ...)` or
   `module("ui.bootstrap").directive(...)`), the vendor module is stripped.
2. Cross-check by grepping the harness for that vendor module's name in
   `HARNESS_VENDOR_DEPS` (server.js) — if it's not listed, cybersponse
   doesn't pull it in either.

### Fix recipe (the picklist popover case, applies generally)

The cs-conditional value picker (Status, Severity, etc.) uses
`uib-popover-template` referencing `app/components/form/typeahead/lookupPopover.html`.
Three things were missing in the harness:

1. **The `ui.bootstrap` module itself.** Loaded `angular-ui-bootstrap-tpls@2.5.6`
   from CDN in `public/index.html` *before* `/_fsr/app.unmin.js`, and added
   `"ui.bootstrap"` to `HARNESS_VENDOR_DEPS` in `server.js` so cybersponse
   declares it as a dep.
2. **The popup template.** SOAR's templates live in
   `fsr_src/templates.min.a64ddbd8.js` (one big `cybersponse.run()` block of
   `$templateCache.put(...)` calls). Added a `/_fsr/templates.min.js` route
   in `server.js` and a `<script>` tag in `public/index.html` to load it
   between `app.unmin.js` and `harness.module.js`.
3. **Removed colliding shims.** harness.module.js had hand-rolled
   `uibDropdown` / `uibDropdownToggle` / `uibDropdownMenu` shims that double-
   registered against the now-real ones. Deleted the shims; kept the
   `$uibModal` stub for now (real `$uibModal` could open unwanted modals;
   revisit per-call-site).

After: clicking the value button opens the real popover, picklistsService
(which was always in app.unmin.js) fetches values, and selection persists
into `$scope.config.customFilters` with the correct `<module>.uuid in [...]`
shape.

### Known stripped vendors (load these in the harness)

Loaded from CDN + listed in `HARNESS_VENDOR_DEPS` (server.js):
- `ui.bootstrap` — uib-popover, uib-tooltip, uib-modal, uib-dropdown,
  uib-tabset, uib-accordion, uib-collapse, uib-progressbar, uib-pagination,
  uib-btn-checkbox/radio, etc. (~1000 attribute uses across SOAR templates)
- `ui.select` — the `<ui-select>` element used by csMultiselect for
  `in`/`nin` operators (~150 uses)
- `ngSanitize` — `$sanitize` for `ng-bind-html` safe content
- `angularMoment` — `amTimeAgo` etc. date filters (requires `moment` first)
- `ngFileUpload` — `Upload` service injected by file-picker controllers

Skipped on purpose (would clash with harness stubs or need extra setup;
add only if a feature actually requires the real implementation):
- `angular-local-storage` — `localStorageService` is stubbed in
  harness.module.js
- `angular-toaster` — `toaster` is stubbed; real one needs a
  `<toaster-container>` mount point
- `angular-ui-router` — `$state` is stubbed; real one would try to route
  away from the harness shell

Expect more discoveries — every `grep -c 'directive("X"' fsr_src/app.unmin.js`
that returns 0 for a directive used in stock SOAR templates is a candidate.

### Bonus gotcha: SOAR's templates bundle has broken expressions

`fsr_src/templates.min.a64ddbd8.js` ships at least one malformed ng-show
expression: `ng-show="($select.items.length > 0) ||"` (dangling `||`) on
the `ui-select-choices` element of the multiselect template (5 occurrences
across templates that use ui-select). `$parse` throws `ueoe` (Unexpected
End Of Expression), which aborts compilation of cs-conditional's value
cell when the operator is `in` / `nin`, so the multiselect picker silently
never renders. Real SOAR loads more vendor scripts that may swallow it.
The harness patches the bundle on serve in `server.js`'s
`/_fsr/templates.min.js` route by string-replacing the trailing `||"` with
`"`. When you add/upgrade the templates bundle, re-run
`grep -c 'items.length > 0) ||"' templates.min.*.js` and update the patch
match if SOAR fixed it upstream.

### When you hit a similar gap

Suspect a stripped vendor any time SOAR's stock UI renders but doesn't react.
The fix is almost always: declare the missing module in `HARNESS_VENDOR_DEPS`,
load the vendor lib + any required templates before bootstrap, and remove
manual shims that are now redundant. Plan B (when loading the real lib is too
disruptive) is a one-directive shim — only worth it for tightly-scoped
features.

---

## License

All files in this knowledgebase that you copy into new widgets must carry:

```
MIT License
Copyright (c) <year> Fortinet Inc
```

Third-party libraries (d3, c3, echarts, vis, etc.) retain their original licenses — ship them under `widgetAssets/js/` or load from a CDN as described in §22.
