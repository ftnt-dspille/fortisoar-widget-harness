"use strict";
// Unit test for the view controller. Boots a bare `cybersponse` module, loads
// the controller IIFE (which self-registers), then $controller-instantiates it
// with mocked injectables and asserts the view-model. Run with:
//
//   make test-unit WIDGET=myWidget        # from the dev-kit root
//   WIDGET=myWidget npm test              # in a standalone clone

global.jasmine = global.jasmine || {};

require("angular");
require("angular-mocks");

angular.module("cybersponse", []); // eslint-disable-line no-undef
require("../widget/view.controller.js");

const CTRL_NAME = "myWidget100DevCtrl";
const ngModule = window.angular.mock.module; // eslint-disable-line no-undef
const ngInject = window.angular.mock.inject; // eslint-disable-line no-undef

function makeController(config) {
  let $scope;
  ngModule("cybersponse", ($provide) => {
    $provide.value("config", config || {});
  });
  ngInject((_$rootScope_, _$controller_) => {
    $scope = _$rootScope_.$new();
    _$controller_(CTRL_NAME, { $scope, config: config || {} });
  });
  return { $scope };
}

describe("myWidget view controller", () => {
  test("greets using the configured title", () => {
    const { $scope } = makeController({ title: "Alice" });
    expect($scope.greeting).toBe("Hello, Alice");
  });

  test("falls back to a default when unconfigured", () => {
    const { $scope } = makeController({});
    expect($scope.greeting).toBe("Hello, Hello");
  });
});
