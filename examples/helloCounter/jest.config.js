"use strict";

module.exports = {
  testEnvironment: "jsdom",
  testEnvironmentOptions: {
    url: "http://localhost/helloCounter-dev/",
  },
  testMatch: ["<rootDir>/tests/**/*.test.js"],
};
