import angular from 'angular';
import 'ui-router';
import 'ng-storage';

const app = angular.module('app', ['ng', 'ui.router', 'ngStorage']);

function ConversationService ($sessionStorage, $http) {

  return {
    /**
     * Create a conversation ID (aka, inbox) for 2 or more users.
     * A direct conversation's ID starts with "d", a group chat ID starts with "g"
     */
    createConversationID (...userIDs) {
      if (!userIDs.length || userIDs.length < 2) {
        throw new Error('Invalid arguments');
      }

      userIDs.sort();
      if (userIDs.length === 2) {
        return 'd_' + userIDs.join('_');
      }
      else if (userIDs.length > 2) {
        return 'g_' + userIDs.join('_');
      }
    },
    fetchConversation (conversationID, marker) {
      var promise = $http.get(`/api/chats`, {
        params: {
          inbox: conversationID,
          marker: marker || undefined
        }
      });

      return promise.then((response) => {
        let { messages } = response.data;
        let currentUserID = $sessionStorage.currentUser.id;
        messages.forEach(item => item.isMyMessage = (currentUserID === item.from_user));

        console.info(`[ConversationService.fetchConversation] Showing conversation with ${messages.length} messages...`);
        return messages;
      });
    },

    getChatters (inbox) {
      let rgx = /^d_(\w+)_(\w+)$/gi;
      let match = rgx.exec(inbox);
      if (!match) {
        throw new Error(`Invalid inbox name ${inbox}`);
      }

      let users = match.slice(1, 3);
      return users;
    }
  }
}
ConversationService.$inject = ['$sessionStorage', '$http'];
app.service('conversationService', ConversationService);

function ServerSentEventSource ($rootScope, $q, $http) {
  let source;

  let disposeEventSource = null;
  let isAcked = false;
  let deferred;

  const EVENT_INBOX = 'inbox';
  const EVENT_NOTIFICATION = 'notification';

  const handlers = {
    [EVENT_INBOX]: [],
    [EVENT_NOTIFICATION]: []
  };

  function connect () {
    if (source) { // && source.readyState === EventSource.OPEN) {
      return deferred.promise;
    }
    console.debug('[ServerSentEventSource] Connecting to event source...');

    deferred = $q.defer();

    source = new EventSource('/stream');
    disposeEventSource = function disposeEventSource() {
      deferred = null;
      source.close();
      source = null;
    };

    source.onerror = onerror;
    source.addEventListener('ack', function (event) {
      isAcked = true;

      console.info('[ServerSentEventSource] Connected to event source');
      deferred.resolve();
    });
    source.addEventListener('inbox', onmessage);
    source.addEventListener('notification', onmessage);

    return deferred.promise;
  }

  function disconnect () {
    console.debug('[ServerSentEventSource] Disconnecting from event source...');
    disposeEventSource && disposeEventSource();
    disposeConnectivityMonitor && disposeConnectivityMonitor();
  }

  function subscribe (eventType, handler) {
    if (!(eventType in handlers)) {
      throw new Error(`event type ${eventType} is invalid`);
    }
    if (!handler || !angular.isFunction(handler)) {
      throw new Error('handler is not a function', handler);
    }

    handlers[eventType].push(handler);

    return function unsubsribe () {
      let index = handlers[eventType].indexOf(handler);
      handlers.splice(index, 1);
    };
  }

  let disposeConnectivityMonitor = null;
  function monitorConnectivity () {
    // credit: https://www.audero.it/demo/page-visibility-api-demo.html
    let hiddenProperty = 'hidden' in document ? 'hidden' :
        'webkitHidden' in document ? 'webkitHidden' :
            'mozHidden' in document ? 'mozHidden' : null;
    let visibilityStateProperty = 'visibilityState' in document ? 'visibilityState' :
        'webkitVisibilityState' in document ? 'webkitVisibilityState' :
            'mozVisibilityState' in document ? 'mozVisibilityState' :
                null;
    var visibilityChangeEvent = hiddenProperty.replace(/hidden/i, 'visibilitychange');
    if (!(hiddenProperty && visibilityStateProperty)) {
      console.warn('[ServerSentEventSource] Cannot monitor connectivity on user`s device.');
      return;
    }
    else {
      function visibilityChangeEventHandler () {
        console.debug('[ServerSentEventSource] visibilitychange event fired');

        if (document[hiddenProperty] === true) {
          disconnect();
        }
        else {
          connect();
        }
      }
      document.addEventListener(visibilityChangeEvent, visibilityChangeEventHandler);

      disposeConnectivityMonitor = function disposeConnectivityMonitor () {
        document.removeEventListener(visibilityChangeEvent, visibilityChangeEventHandler);
      };
      return disposeConnectivityMonitor;
    }
  }

  function onmessage(message) {
    $rootScope.$apply(function () {
      var data;
      var type;
      try {
        data = JSON.parse(message.data);
        type = message.type;
      }
      catch (e) {
        console.error(e);
        return;
      }

      switch (type) {
        case 'inbox':
          console.log(`[onmessage] Inbox...`, data);
          let {inbox, marker} = data;

          handlers['inbox'].forEach(handler => {
            handler.apply(null, [inbox, marker]);
          });

          break;
        case 'notification':
          console.log(`[onmessage] Notification...`, data);
          let promises = [];
          angular.forEach(data, function(item, index) {
            let deferred = $q.defer();
            promises.push(deferred.promise);

            if (angular.isObject(item) && 'data_uri' in item) {
              $http.get(item['data_uri']).then((response) => {
               let { users } = response.data;
               deferred.resolve({key: index, value: users});
              });
              return;
            }

            deferred.resolve({key: index, value: item});
          });

          $q.all(promises).then((results) => {
            let data = results.reduce(function (acc, item) {
              acc[item.key] = item.value;
              return acc;
            }, {});

            handlers['notification'].forEach(handler => {
              handler.apply(null, [data]);
            });
          });

          break;
      }
    });
  }

  function onerror (e) {
    source.close();
    source = null;
    isAcked = false;
  }

  return {
    connect,
    subscribe,
    disconnect,
    monitorConnectivity
  }
}
ServerSentEventSource.$inject = ['$rootScope', '$q', '$http'];
app.service('sse', ServerSentEventSource);

function AuthenticationService ($http, $rootScope, $q, $sessionStorage, $state) {
  return {
    get currentUser () {
      return $sessionStorage.currentUser;
    },
    login (userID, username) {
      console.log(`[LoginCtrl] Logging in as ${userID} => ${username}`);

      let promise = $http.post('/api/auth', {
        user_id: userID,
        username: username
      });

      return promise.then((response) => {
        console.log(`[LoginCtrl] Login status: ${response.data}`);
        let { data } = response;
        if (data === 'ok') {
          $sessionStorage.currentUser = {
            id: userID
          };

          return true;
        }
        else {
          return false;
        }
      })
    },
    logout () {
      if (!$sessionStorage.currentUser) {
        return;
      }
      let promise = $http.delete('/api/auth');
      return promise.then(() => {
        delete $sessionStorage.currentUser;

        $state.go('login');
      });
    }
  };
}
AuthenticationService.$inject = ['$http', '$rootScope', '$q', '$sessionStorage', '$state'];
app.service('authService', AuthenticationService);

function ChatroomCtrl ($rootScope, $scope, $element, $timeout, $sessionStorage, $http, conversationService, sse) {
  getFriendList();
  // UI Bound variables
  $scope.showingRightSide = false;

  $scope.friends = [];
  $scope.selectedFriend = null;
  $scope.currentConversationID = null;

  $scope.message = {content: ''};
  $scope.messages = [];

  $scope.tzOffset = (function () {
    let leftPaddedTzOffset = '0' + -(new Date().getTimezoneOffset());
    return (leftPaddedTzOffset.length === 4)?leftPaddedTzOffset:leftPaddedTzOffset.substr(1);
  })();
  $scope.tzOffset = 'GMT+0800';

  sse.subscribe('inbox', function onInbox (inbox, marker) {
    if (inbox !== $scope.currentConversationID) {
      console.info(`[onmessage] Someone has sent you a message...`);
      let chatters = conversationService.getChatters(inbox);
      let { id:userID } = $sessionStorage.currentUser;
      let myIndex = chatters.indexOf(userID);
      chatters.splice(myIndex, 1);
      let friend = $scope.friends.find(item => item.id === chatters[0]);

      friend.hasUnread = true;
      return;
    }

    fetchConversation(inbox, marker);
  });
  sse.subscribe('notification', function onNotification (data) {
    let usersList = data['users_list'];
    $scope.friends = usersList;
  });
  sse.connect();
  sse.monitorConnectivity();

  $scope.startChattingWithFriend = (friend) => {
    if ($scope.selectedFriend && friend !== $scope.selectedFriend) {
      $scope.selectedFriend.isSelected = false;
      $scope.selectedFriend = friend;
      friend.isSelected = true;
    }
    else if (!$scope.selectedFriend) {
      $scope.selectedFriend = friend;
      $scope.selectedFriend.isSelected = true;
    }

    $scope.showingRightSide = false;

    let currentConversationID = conversationService.createConversationID($sessionStorage.currentUser.id, friend.id);
    console.info(`[ChatroomCtrl] Starting a chat with ${friend.id}`);
    $scope.messages = [];
    $scope.currentConversationID = currentConversationID;

    friend.hasUnread = false;
    fetchConversation(currentConversationID);
  };

  $scope.sendChatMessage = (message) => {
    if (!$scope.currentConversationID) {
      console.warn(`[ChatroomCtrl] User must have a conversation first`);
      return;
    }
    if (!message) {
      console.warn(`[ChatroomCtrl] Cannot send an empty chat message`);
      return;
    }

    let promise = $http.post(`/api/chats?inbox=${$scope.currentConversationID}`, message);
    promise.then((response) => {
      console.log(response);

      if ($scope.message.content === message) {
        $scope.message.content = '';
      }
      else {
        console.warn(`[ChatroomCtrl] Current message has changed. Cannot clear`);
      }
    });
  };

  $scope.handleKeypress = function (e, message) {
    if (e.keyCode === 13) {
      e.preventDefault();
      $scope.sendChatMessage(message);
    }
  };

  $scope.toggleRightSide = () => {
    $scope.showingRightSide = !$scope.showingRightSide;
  };

  function getFriendList () {
    $http.get(`/api/friends`).then((response) => {
      let { users } = response.data;

      $scope.friends = users;
    });
  }

  function fetchConversation (conversationID, marker) {
    var promise = conversationService.fetchConversation(conversationID, marker);
    promise.then((messages) => {
      console.info(`[ChatroomCtrl.showConversation] Showing conversation with ${messages.length} messages...`);
      $scope.messages = $scope.messages.concat(messages);

      $timeout(function () {
        let $conversionItem = $element[0].querySelector('.conversation-item:last-child');
        $conversionItem.scrollIntoView({behavior: 'smooth'});
      }, 0);
    });
  }
}
ChatroomCtrl.$inject = ['$rootScope', '$scope', '$element', '$timeout', '$sessionStorage', '$http', 'conversationService', 'sse'];

function LoginCtrl ($rootScope, $scope, authService, $http, $state) {
  $scope.login = () => {
    console.log(`[LoginCtrl] Logging in as ${$scope.user_id} => ${$scope.username}`);

    authService.login($scope.user_id, $scope.username).then(() => {
      $state.go('authorized');
    });
  };
}
LoginCtrl.$inject = ['$rootScope', '$scope', 'authService', '$http', '$state'];

function HeaderDirective ($http, authService, sse) {
  return {
    restrict: 'A',
    scope: {
      toggleFriends: '&'
    },
    link (scope, element) {
      scope.currentUser = authService.currentUser;
      scope.onlineUsers = 0;

      sse.subscribe('notification', function onNotification (data) {
        scope.onlineUsers = data['online_users_count'];
      });

      sse.connect().then(() => {
        $http.get('/api/friends?summary=count').then(response => {
          let { data } = response;
          scope.onlineUsers = data['count'];
        })
      });

      scope.logout = function () {
        authService.logout();
        sse.disconnect();
      };

      scope.toggleCollapse = function () {
        scope.isMenuIn = !scope.isMenuIn;
      };
    },
    templateUrl: '/ui-header.tpl.html'
  }
}
HeaderDirective.$inject = ['$http', 'authService', 'sse'];
app.directive('uiHeader', HeaderDirective);

app.filter('asDate', function () {
  return function (input) {
    return new Date(input);
  };
});

app.config(['$locationProvider', '$stateProvider', function ($locationProvider, $stateProvider) {
  $locationProvider.html5Mode(false);

  $stateProvider.state('login', {
    url: '/',
    templateUrl: '/login.tpl.html',
    controller: LoginCtrl
  });

  $stateProvider.state('authorized', {
    url: '/chatroom',
    templateUrl: '/chatroom.tpl.html',
    controller: ChatroomCtrl
  });
}]);

export default app;
