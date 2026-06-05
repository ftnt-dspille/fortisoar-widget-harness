/* Copyright start
   MIT License
   Copyright (c) 2026 FortiSOAR Widget Harness
   Copyright end */
"use strict";
// Example widget — the EDIT controller. Runs inside a $uibModal when the user
// configures the widget. `editHelloCounter100DevCtrl` is the convention:
// `edit` + Capitalized name + numeric version + `DevCtrl`.
(function () {
  angular
    .module("cybersponse")
    .controller("editHelloCounter100DevCtrl", editHelloCounter100DevCtrl);

  editHelloCounter100DevCtrl.$inject = ["$scope", "$uibModalInstance", "config"];

  function editHelloCounter100DevCtrl($scope, $uibModalInstance, config) {
    var defaults = { label: "Clicks", start: 0, step: 1 };
    $scope.config = angular.extend({}, defaults, config || {});

    $scope.cancel = function () {
      $uibModalInstance.dismiss("cancel");
    };

    $scope.save = function () {
      // Coerce numerics — empty inputs arrive as "" and would corrupt the view.
      $scope.config.start = Number($scope.config.start) || 0;
      $scope.config.step = Number($scope.config.step) || 1;
      $uibModalInstance.close($scope.config);
    };
  }
})();
