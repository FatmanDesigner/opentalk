import angular from 'angular';
import 'ui-router';
import 'ng-storage';

const app = angular.module('app', ['ng', 'ui.router', 'ngStorage']);

function ChatroomCtrl ($rootScope, $scope, $sessionStorage, $http) {
  getFriendList();

  $scope.currentConversationID = null;
  $scope.messages = [];
  $scope.disposeSource = null;

  $scope.startChattingWithFriend = (friend) => {
    let currentConversationID = createConversationID($sessionStorage.currentUser.id, friend.id);
    console.info(`[ChatroomCtrl] Starting a chat with ${friend.id}`);
    $scope.messages = [];
    $scope.currentConversationID = currentConversationID;

    if ($scope.disposeSource) {
      $scope.disposeSource();
    }
    showConversation(currentConversationID);
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

      if ($scope.message === message) {
        $scope.message = '';
      }
      else {
        console.warn(`[ChatroomCtrl] Current message has changed. Cannot clear`);
      }
    });
  };

  function getFriendList () {
    $http.get(`/api/friends`).then((response) => {
      console.log(response.data);
      let { users } = response.data;

      $scope.friends = users;
    });
  }

  function showConversation (conversationID) {
    var promise = $http.get(`/api/chats`, {
      params: {
        inbox: conversationID
      }
    });

    promise.then((response) => {
      let { messages } = response.data;

      console.info(`[ChatroomCtrl.showConversation] Showing conversation with ${messages.length} messages...`);
      $scope.messages = messages;
    });

    promise.then(function () {
      $scope.disposeSource = getConversationStream(conversationID);
    });
  }

  function getConversationStream (conversationID, marker) {
    console.log(`[getConversationStream] Waiting for more messages...`);
    var source = new EventSource(`/stream/${conversationID}?marker=${marker || Date.now()}`);

    var handler = (response) => {
      console.debug(response.data);
      let data;
      let messages;

      try {
        messages = JSON.parse(response.data);

        console.log(`[getConversationStream] Retrieved ${messages.length} messages.`);
        $scope.messages = $scope.messages.concat(messages);

        $scope.$apply();
      }
      catch (e) {
        console.error(e);
      }
    };

    source.onmessage = handler;

    return function () {
      console.log(`[disposeSource] Disposing message source...`);

      source.close();
    }
  }
  /**
   * Create a conversation ID (aka, inbox) for 2 or more users.
   * A direct conversation's ID starts with "d", a group chat ID starts with "g"
   */
  function createConversationID () {
    let userIDs = Array.prototype.slice.call(arguments, 0);
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
  }
}
ChatroomCtrl.$inject = ['$rootScope', '$scope', '$sessionStorage', '$http'];

function LoginCtrl ($rootScope, $scope, $sessionStorage, $http, $state) {
  $scope.login = () => {
    console.log(`[LoginCtrl] Logging in as ${$scope.user_id} => ${$scope.username}`);

    let promise = $http.post('/api/auth', {
      user_id: $scope.user_id,
      username: $scope.username
    });

    promise.then((response) => {
      console.log(`[LoginCtrl] Login status: ${response.data}`);
      let { data } = response;
      if (data === 'ok') {
        $sessionStorage.currentUser = {
          id: $scope.user_id
        };

        $state.go('authorized');
      }
    })
  };
}
LoginCtrl.$inject = ['$rootScope', '$scope', '$sessionStorage', '$http', '$state'];

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
