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

function ChatroomCtrl ($rootScope, $scope, $sessionStorage, $http, conversationService) {
  getFriendList();

  $scope.friends = [];
  $scope.currentConversationID = null;
  $scope.messages = [];
  $scope.disposeSource = connect();

  $scope.startChattingWithFriend = (friend) => {
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

  function fetchConversation (conversationID, marker) {
    var promise = conversationService.fetchConversation(conversationID, marker);
    promise.then((messages) => {
      console.info(`[ChatroomCtrl.showConversation] Showing conversation with ${messages.length} messages...`);
      $scope.messages = $scope.messages.concat(messages);
    });
  }

  function connect () {
    var source = new EventSource('/stream');
    source.addEventListener('inbox', onmessage);
    source.addEventListener('notification', onmessage);

    function onmessage (message) {
      $scope.$apply(function () {
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
            if (inbox !== $scope.currentConversationID) {
              console.info(`[onmessage] Someone has sent you a message...`);
              let chatters = conversationService.getChatters(inbox);

              let { id:userID } = $sessionStorage.currentUser;
              let myIndex = chatters.indexOf(userID);
              chatters.splice(myIndex, 1);

              let friend = $scope.friends.find(item => item.id === chatters[0]);
              friend.hasUnread = true;
              break;
            }

            fetchConversation(inbox, marker);
            break;
          case 'notification':
            console.log(`[onmessage] Notification...`, data);
            break;
        }
      });
    }

    return function dispose() {
      source.close();
    };
  }
}
ChatroomCtrl.$inject = ['$rootScope', '$scope', '$sessionStorage', '$http', 'conversationService'];

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

function HeaderDirective ($sessionStorage) {
  return {
    restrict: 'A',
    link (scope) {
      scope.currentUser = $sessionStorage.currentUser;
    },
    template: `
    <nav class="navbar navbar-default navbar-fixtop">
      <div class="container-fluid">
        <div class="navbar-header">
          <button type="button" class="navbar-toggle collapsed" data-toggle="collapse" data-target="#navbar" aria-expanded="false" aria-controls="navbar">
            <span class="sr-only">Toggle navigation</span>
            <span class="icon-bar"></span>
            <span class="icon-bar"></span>
            <span class="icon-bar"></span>
          </button>
          <a class="navbar-brand" href="#">OpenTalk</a>
        </div>
        <div id="navbar" class="navbar-collapse collapse">

          <ul class="nav navbar-nav">
            <li class="active"><a href="#">Chat Room</a></li>
            <li>
              <a href="https://github.com/khanhhua/opentalk">
                <i class="fa fa-github"></i> Fork me!
              </a>
            </li>
          </ul>
          <ul class="nav navbar-nav navbar-right">
            <li>
              <a><i class="fa fa-user"></i> {{currentUser.id}}</a>
            </li>
            <li>
              <button class="btn navbar-btn btn-small btn-danger"><i class="fa fa-power-off"></i> Log out</button>
            </li>
          </ul>
        </div>
      </div>
    </nav>`
  }
}
HeaderDirective.$inject = ['$sessionStorage'];
app.directive('uiHeader', HeaderDirective);

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
