from os import path
from time import time
import calendar
import re

from tornado.concurrent import Future
from tornado.escape import json_decode, json_encode

import tornado.ioloop
from tornado import gen, web
from tornado.iostream import StreamClosedError

from db import Db, User

class ApiHandler(web.RequestHandler):
    def __init__(self, application, request):
        super().__init__(application, request)
        self.set_header('Content-Type', 'application/json')

    def get_current_user(self):
        user_id  = self.get_secure_cookie('user')
        if user_id:
            return user_id.decode('utf-8');
        else:
            return None

    def get(self):
        self.write("Chat API v.1.0")


class AuthHandler(ApiHandler):


    def post(self):
        print("[AuthHandler] Request body {}".format(self.request.body))

        data = json_decode(self.request.body)
        user_id = data.get('user_id', None)
        username = data.get('username', None)

        if not user_id:
            raise Exception('User ID (user_id) is required')

        user = self.application.db.find_user_by_id(user_id)
        if user is None and username:
            self.application.db.create_user(user_id, username)
        elif user is None:
            return self.send_error(status_code=400, reason='User is not found and user name is not given')

        self.set_secure_cookie("user", user_id)
        self.write(json_encode('ok'))


class ChannelHandler(ApiHandler):

    def __init__(self, application, request):
        super().__init__(application, request)
        self.set_header('Content-Type', 'text/event-stream')

    @gen.coroutine
    def get(self):
        user = self.current_user
        if not user:
            return self.send_error(status_code=403, reason='Not authorized')

        self.application.db.update_user(user, status=User.STATUS_ONLINE)

        while True:
            yield self.application.wait(user)
            result = self.application.get_wait_result(user)

            type = result[0]
            data = result[1]
            if type == 'inbox':
                inbox = data['inbox']
                marker = data['marker']
                self.send_messages(inbox, marker)
            elif type == 'notification':
                self.send_notification()

            yield self.flush()



    def send_messages(self, inbox, marker):
        print("Sending 'inbox' event to user")
        data = json_encode({
            'inbox': inbox,
            'marker': marker
        })
        self.write('event: inbox\ndata: {}\n\n'.format(data))

    def send_notification(self):
        pass

    def on_connection_close(self):
        user = self.current_user
        print("User {} has disconnected...".format(user))

        self.application.db.update_user(user, status=User.STATUS_OFFLINE)
        self.application.cancel_wait(user)

        super().on_connection_close()


class FriendsHandler(web.RequestHandler):
    def __init__(self, application, request):
        super().__init__(application, request)
        self.set_header('Content-Type', 'application/json')

    def get_current_user(self):
        user_id  = self.get_secure_cookie('user')
        if user_id:
            return user_id.decode('utf-8');
        else:
            return None

    @gen.coroutine
    def get(self):
        current_user_id = self.get_current_user()
        users = self.application.db.find_users(friends_of_user=current_user_id)

        self.write(json_encode({
            'ok': True,
            'users': [{ 'id': user.user_id, 'username': user.username } for user in users]
        }))


class ConversationHandler(web.RequestHandler):
    """
    Users post messages and get messages from this handler.
    Each GET and POST should receive the following params:
    - conversion_id

    GET should have
    - marker: If not given, all messages will be loaded for the conversation

    POST should indicate
    - message text
    """
    def __init__(self, application, request):
        super().__init__(application, request)

        self.set_header('Content-Type', 'application/json')

    def get_current_user(self):
        user_id  = self.get_secure_cookie('user')
        if user_id:
            return user_id.decode('utf-8');
        else:
            return None

    @gen.coroutine
    def get(self):
        conversation_id = self.get_query_argument('inbox', None)
        marker = self.get_query_argument('marker', None)

        print('[ConversationHandler] Getting messages for conversation {} at marker {}'.format(conversation_id, marker))
        messages = self.application.db.find_messages(conversation_id, int(marker) if marker else None)

        self.write(json_encode({
            'ok': True,
            'messages': [item.to_dict() for item in messages]
        }))

    @gen.coroutine
    def post(self):
        current_user_id = self.get_current_user()
        inbox = self.get_query_argument('inbox', None)
        text = self.request.body.decode('utf-8')

        print('[ConversationHandler] Posting a message to conversation #{}'.format(inbox))

        message = self.application.db.create_message(current_user_id, inbox, text)

        self.set_header('Content-Type', 'application/json')
        self.write(json_encode('ok'))

        # A simplistic logic to find out who to notify
        rgx = re.compile('d_(\w+)_(\w+)', re.IGNORECASE)
        match = rgx.match(inbox)
        users = match.groups()
        marker = int(message.created_at.timestamp())

        for user in users:
            self.application.notify_waiter(user, 'inbox', {'inbox': inbox, 'marker': marker})

        yield self.flush()


class Application(web.Application):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.db = kwargs.get('db', None)
        self.active_inboxes = dict()
        self.waiters = dict()
        self.waiter_results = dict()

    @gen.coroutine
    def wait(self, user):
        if user in self.waiters:
            yield self.waiters[user]
        future = Future()
        self.waiters[user] = future

        yield future

    def get_wait_result(self, user):
        if not user in self.waiter_results:
            return None

        return self.waiter_results[user]

    def cancel_wait(self, user):
        if user in self.waiters:
            del self.waiters[user]

    def notify_waiter(self, user, type, kwargs):
        if not user in self.waiters:
            return

        result = (type, kwargs)
        self.waiter_results[user] = result
        self.waiters[user].set_result(result)

        del self.waiters[user]

    @gen.coroutine
    def wait_for_inbox(self, inbox):
        if not inbox in self.active_inboxes:
            self.active_inboxes[inbox] = []

        future = Future()
        self.active_inboxes[inbox].append(future)

        print('[Application.wait_for_inbox] Waiting for inbox {}'.format(inbox))
        yield future

    def notify_inbox(self, inbox):
        if not inbox in self.active_inboxes:
            print('[Application.notify_inbox] Inbox {} is not in active boxes. No op.'.format(inbox))
            return

        for future in self.active_inboxes[inbox]:
            future.set_result(True)

        self.active_inboxes[inbox].clear()


def make_app():
    base_dir = path.join(path.dirname(path.realpath(__file__)), "..")
    static_dir = path.realpath(path.join(base_dir, 'static'))
    print("Using static dir: {}".format(static_dir))

    database_path = path.realpath(path.join(base_dir, 'run', 'db.sqlite'))
    print("Using database path: {}".format(database_path))
    db = Db('sqlite:///' + database_path)
    db.create_all()

    return Application(
        [
            (r"/api", ApiHandler),
            (r"/api/auth", AuthHandler),
            (r"/api/friends", FriendsHandler),
            (r"/api/chats", ConversationHandler),
            (r"/stream", ChannelHandler),
            (r"/(.*)", web.StaticFileHandler, {"path": static_dir, "default_filename": "index.html"}),
        ],
        debug=True,
        db=db,
        cookie_secret='s3cr3t')

if __name__ == "__main__":
    app = make_app()
    app.listen(8888)
    tornado.ioloop.IOLoop.current().start()
