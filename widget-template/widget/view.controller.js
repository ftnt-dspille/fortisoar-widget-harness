/* Copyright start
   MIT License
   Copyright (c) 2026 Your Team
   Copyright end */
"use strict";
// VIEW controller. The harness/SOAR resolves the controller name as
// `<name><numericVersion>DevCtrl` — myWidget100DevCtrl for myWidget v1.0.0.
// `widget bump` rewrites this suffix on a version change; never hand-edit it.
(function () {
  angular
    .module("cybersponse")
    .controller("myWidget100DevCtrl", myWidget100DevCtrl);

  // List every service in BOTH $inject and the function args, same order
  // (AngularJS 1.x minification-safe DI). `config` is the persisted widget
  // config set in edit.html.
  myWidget100DevCtrl.$inject = ["$scope", "config"];

  function myWidget100DevCtrl($scope, config) {
    var defaults = { title: "Hello" };
    // Guard config — a drawer cold-mount can pass nothing.
    $scope.config = angular.extend({}, defaults, config || {});

    // Keep view logic pure + small so the jest test can exercise it headless.
    $scope.greeting = "Hello, " + ($scope.config.title || "world");
  }
})();
