from os import path, environ, makedirs
from time import time, sleep
import calendar
import re

from concurrent.futures import ThreadPoolExecutor
from tornado.concurrent import Future
from tornado.escape import json_decode, json_encode

import tornado.ioloop
from tornado import gen, web

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

    def delete(self):
        user = self.current_user
        self.application.notify_waiter(user, 'logout')

        self.clear_cookie('user')
        self.write(json_encode('ok'))

class ChannelHandler(ApiHandler):

    def __init__(self, application, request):
        super().__init__(application, request)
        self.set_header('Content-Type', 'text/event-stream')

    @gen.coroutine
    def get(self):
        user = self.current_user
        if not user:
            self.send_error(status_code=403, reason='Not authorized')
            return

        update_result = self.application.db.update_user(user, status=User.STATUS_ONLINE)
        if not update_result:
            self.send_error(status_code=403, reason='Not authorized')
            return
        self.update_user_presence_stats()

        self.write('event: ack\ndata: {}\n\n'.format(int(time())))
        yield self.flush()

        while True:
            yield self.application.wait(user)
            result = self.application.get_wait_result(user)

            type = result[0]
            data = result[1]

            if type == 'heartbeat':
                self.send_heart_beat()
            elif type == 'inbox':
                inbox = data['inbox']
                marker = data['marker']
                self.send_messages(inbox, marker)
            elif type == 'notification':
                self.send_notification(data)
            elif type == 'logout':
                self.application.db.update_user(user, status=User.STATUS_OFFLINE)
                self.application.cancel_wait(user)
                self.update_user_presence_stats()
                self.finish()
                break

            try:
                yield self.flush()
            except tornado.iostream.StreamClosedError as e:
                break

    def send_heart_beat(self):
        self.write('event: heartbeat\ndata: {}\n\n'.format(int(time())))

    def send_messages(self, inbox, marker):
        print("Sending 'inbox' event to user")
        data = json_encode({
            'inbox': inbox,
            'marker': marker
        })
        self.write('event: inbox\ndata: {}\n\n'.format(data))

    def send_notification(self, data):
        print("Sending 'notification' event to user")
        serialized = json_encode(data)
        self.write('event: notification\ndata: {}\n\n'.format(serialized))

    def on_connection_close(self):
        user = self.current_user
        print("[ChannelHandler:on_connection_close] User {} has disconnected...".format(user))

        self.application.cancel_wait(user)
        self.application.db.update_user(user, status=User.STATUS_OFFLINE)
        self.update_user_presence_stats()

        print('[on_connection_close] Done notifying all users')
        super().on_connection_close()

    def update_user_presence_stats(self):
        users = self.application.db.find_users()
        users_data_uri = {'data_uri': '/api/friends'}
        online_users = self.application.db.count_online_users()


        print('[ChannelHandler:update_user_presence_stats] Total online users: {}'.format(online_users))

        for item in users:
            self.application.notify_waiter(item.user_id, 'notification',
                                           users_list=users_data_uri,
                                           online_users_count=online_users)


class FriendsHandler(ApiHandler):

    @gen.coroutine
    def get(self):
        summary = self.get_query_argument('summary', default=None)

        if summary is None:
            current_user_id = self.get_current_user()
            users = self.application.db.find_users(friends_of_user=current_user_id)

            self.write(json_encode({
                'ok': True,
                'users': [{
                              'id': user.user_id,
                              'username': user.username,
                              'status': 'online' if user.status == User.STATUS_ONLINE else 'offline'
                          } for user in users]
            }))
            return
        else:
            fields = summary.split(',')
            if 'count' in fields:
                count = self.application.db.count_online_users()
                self.write(json_encode({
                    'ok': True,
                    'count': count
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
            self.application.notify_waiter(user, 'inbox', inbox=inbox, marker=marker)

        yield self.flush()


class RoutedStaticHandler(web.StaticFileHandler):

    def parse_url_path(self, url_path):
        return 'index.html'


class Application(web.Application):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.db = kwargs.get('db', None)
        self.active_inboxes = dict()
        self.waiters = dict()
        self.waiter_results = dict()

        self.heart_beat_executor = ThreadPoolExecutor(4)
        self.is_heart_beating = False

    @gen.coroutine
    def wait(self, user):
        if not self.is_heart_beating:
            self.start_heart_beats()

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

    def notify_waiter(self, user, type, **kwargs):
        if not user in self.waiters:
            return

        result = (type, kwargs)
        self.waiter_results[user] = result
        self.waiters[user].set_result(result)

        del self.waiters[user]

    def start_heart_beats(self):
        def send_heart_beat():
            while self.is_heart_beating:
                for user_id, future in self.waiters.items():
                    future.set_result(('heartbeat', ))
                sleep(30)

        self.is_heart_beating = True
        self.heart_beat_executor.submit(send_heart_beat)


def make_app():
    base_dir = path.join(path.dirname(path.realpath(__file__)), "..")
    static_dir = path.realpath(path.join(base_dir, 'static'))
    print("Using static dir: {}".format(static_dir))

    # makedirs(path.realpath(path.join(base_dir, 'run')))
    # database_path = path.realpath(path.join(base_dir, 'run', 'db.sqlite'))
    # print("Using database path: {}".format(database_path))
    conn_string = environ.get('DATABASE_URL', None)
    if conn_string is None:
        exit('Database configuration not found')
        return

    db = Db(conn_string)
    db.create_all()

    return Application(
        [
            (r"/api", ApiHandler),
            (r"/api/auth", AuthHandler),
            (r"/api/friends", FriendsHandler),
            (r"/api/chats", ConversationHandler),
            (r"/stream", ChannelHandler),
            (r"/(.+\.(css|js|html))", web.StaticFileHandler, {"path": static_dir}),
            (r"/(.*)", RoutedStaticHandler, {"path": static_dir, "default_filename": "index.html"}),
        ],
        debug=False,
        db=db,
        cookie_secret='s3cr3t')

if __name__ == "__main__":
    app = make_app()

    port = environ.get('PORT', '8888')
    app.listen(int(port))
    tornado.ioloop.IOLoop.current().start()
