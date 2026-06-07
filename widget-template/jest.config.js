"use strict";

module.exports = {
  testEnvironment: "jsdom",
  testEnvironmentOptions: {
    url: "http://localhost/myWidget-dev/",
  },
  testMatch: ["<rootDir>/tests/**/*.test.js"],
};
