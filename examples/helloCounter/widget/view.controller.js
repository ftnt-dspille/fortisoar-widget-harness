/* Copyright start
   MIT License
   Copyright (c) 2026 FortiSOAR Widget Harness
   Copyright end */
"use strict";
// Example widget — the VIEW controller. The harness/SOAR resolves the
// controller name as `<name><numericVersion>DevCtrl`, i.e. helloCounter100DevCtrl
// for helloCounter v1.0.0. `widget bump` rewrites this suffix automatically on a
// version change, so never hand-edit the digits.
(function () {
  angular
    .module("cybersponse")
    .controller("helloCounter100DevCtrl", helloCounter100DevCtrl);

  // `config` is the persisted widget configuration (set in edit.html). Every
  // service the controller needs must be listed here AND in the function args,
  // in the same order — AngularJS 1.x with minification-safe DI.
  helloCounter100DevCtrl.$inject = ["$scope", "config"];

  function helloCounter100DevCtrl($scope, config) {
    var defaults = { label: "Clicks", start: 0, step: 1 };
    $scope.config = angular.extend({}, defaults, config || {});

    // Pure, unit-testable view-model. The jest test in tests/ exercises exactly
    // this logic without a browser.
    $scope.count = Number($scope.config.start) || 0;
    var step = Number($scope.config.step) || 1;

    $scope.increment = function () {
      $scope.count += step;
    };
    $scope.decrement = function () {
      $scope.count -= step;
    };
    $scope.reset = function () {
      $scope.count = Number($scope.config.start) || 0;
    };
  }
})();
