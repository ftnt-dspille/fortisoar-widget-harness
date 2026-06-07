/* Copyright start
   MIT License
   Copyright (c) 2026 Your Team
   Copyright end */
"use strict";
// EDIT controller — the config editor. It loads only when the host opens
// "Edit Config". The SOAR shell opens it as a $uibModal, so wire both the
// overlay path and the modal close/dismiss contract.
(function () {
  angular
    .module("cybersponse")
    .controller("editMyWidget100DevCtrl", editMyWidget100DevCtrl);

  editMyWidget100DevCtrl.$inject = ["$scope"];

  function editMyWidget100DevCtrl($scope) {
    // `$scope.config` is bound to the widget config the view will receive.
    $scope.config = $scope.config || {};
    if ($scope.config.title === undefined) $scope.config.title = "Hello";
  }
})();
