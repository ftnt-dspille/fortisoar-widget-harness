"use strict";
// Example unit test — the pattern every widget follows. Runs under jsdom with
// angular + angular-mocks resolved from the harness's node_modules (see the
// harness jest.config.js `moduleDirectories`). Run it with:
//
//   WIDGET=helloCounter npm test          # in a clone (examples/ is discovered)
//   make test-unit WIDGET=helloCounter    # from the monorepo root
//
// It boots a bare `cybersponse` module, loads the controller IIFE (which
// self-registers against that module), then $controller-instantiates it with
// mocked injectables and asserts the view-model behaves.

global.jasmine = global.jasmine || {};

require("angular");
require("angular-mocks");

angular.module("cybersponse", []); // eslint-disable-line no-undef
require("../widget/view.controller.js");

const CTRL_NAME = "helloCounter100DevCtrl";
const ngModule = window.angular.mock.module; // eslint-disable-line no-undef
const ngInject = window.angular.mock.inject; // eslint-disable-line no-undef

function makeController(config) {
  let $scope, ctrl;
  ngModule("cybersponse", ($provide) => {
    $provide.value("config", config || {});
  });
  ngInject((_$rootScope_, _$controller_) => {
    $scope = _$rootScope_.$new();
    ctrl = _$controller_(CTRL_NAME, { $scope, config: config || {} });
  });
  return { $scope, ctrl };
}

describe("helloCounter view controller", () => {
  test("starts at the configured start value", () => {
    const { $scope } = makeController({ start: 5 });
    expect($scope.count).toBe(5);
  });

  test("defaults start to 0 and step to 1 when unconfigured", () => {
    const { $scope } = makeController({});
    expect($scope.count).toBe(0);
    $scope.increment();
    expect($scope.count).toBe(1);
  });

  test("increment / decrement honor the configured step", () => {
    const { $scope } = makeController({ start: 10, step: 4 });
    $scope.increment();
    expect($scope.count).toBe(14);
    $scope.decrement();
    $scope.decrement();
    expect($scope.count).toBe(6);
  });

  test("reset returns to the start value", () => {
    const { $scope } = makeController({ start: 3, step: 2 });
    $scope.increment();
    $scope.increment();
    expect($scope.count).toBe(7);
    $scope.reset();
    expect($scope.count).toBe(3);
  });
});
