System.config({
  baseURL: "/js",
  defaultJSExtensions: true,
  transpiler: "babel",
  paths: {
    //"angular": "https://cdnjs.cloudflare.com/ajax/libs/angular.js/1.5.8/angular.js",
    //"ui-router": "https://cdnjs.cloudflare.com/ajax/libs/",
    "cdnjs:*": "https://cdnjs.cloudflare.com/ajax/libs/*",
    "*": "app/*"
  },
  meta: {
    angular: {
      "format": "global",
      "exports": "angular"
    },
    "ui-router": {
      "format": "global",
      deps: [
        "angular"
      ]
    },
    "ng-storage": {
      "format": "global",
      deps: [
        "angular"
      ]
    },
    babel: {
      format: 'cjs',
      exports: 'Babel'
    },
    '*': {
      format: 'es6'
    }
  },
  map: {
    "babel": "cdnjs:babel-core/5.8.34/browser.js",
    "angular": "cdnjs:angular.js/1.5.8/angular.js",
    "ng-storage": "cdnjs:ngStorage/0.3.10/ngStorage.min.js",
    "ui-router": "cdnjs:angular-ui-router/0.3.1/angular-ui-router.min.js"
  }
})
