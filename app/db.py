import datetime
from time import time

from sqlalchemy import *
from sqlalchemy.orm import *
import sqlalchemy.ext.declarative

from tornado import gen
from tornado.concurrent import Future
from tornado.gen import Return
from tornado.ioloop import IOLoop

from concurrent.futures import ThreadPoolExecutor

Base = sqlalchemy.ext.declarative.declarative_base()

class User(Base):
    __tablename__ = 'users'

    STATUS_OFFLINE = 1
    STATUS_ONLINE = 2

    user_id = Column(String(20), primary_key=True)
    username = Column(String(40))
    status = Column(Integer, default=STATUS_OFFLINE)


class Message(Base):
    __tablename__ = 'messages'
    __table_args__ = {'sqlite_autoincrement': True}

    message_id = Column(Integer, autoincrement=True, primary_key=True)
    from_user = Column(String(20), nullable=False)
    inbox = Column(String(20), nullable=False)
    created_at = Column(TIMESTAMP, nullable=False, default=lambda: (datetime.datetime.now().replace(microsecond=0)))
    text = Column(String(255), nullable=False)

    def to_dict(self):
        return dict(message_id=self.message_id,
                    from_user=self.from_user,
                    inbox=self.inbox,
                    created_at=str(self.created_at),
                    text=self.text)


class UndeliveredMessage(Base):
    __tablename__ = 'undelivered_messages'
    __table_args__ = {'sqlite_autoincrement': True}

    undelivered_id = Column(Integer, autoincrement=True, primary_key=True)
    message_id = Column(Integer, ForeignKey('messages.message_id'))
    # to_user is not the same as inbox
    to_user = Column(String(20), nullable=False)
    created_at = Column(TIMESTAMP, nullable=False, default=lambda: (datetime.datetime.now().replace(microsecond=0)))

    message = relationship('Message')


class Db(object):
    """
    Connection
    """

    def __init__(self, connection):
        self.connection = connection
        self.engine = create_engine(self.connection)
        self.engine.echo = True  # Try changing this to True and see what happens

        self.sessionmaker = scoped_session(sessionmaker(bind=self.engine))
        Base.metadata.bind = self.engine

        self.executor = ThreadPoolExecutor(8)

    def create_all(self):
        Base.metadata.create_all()

    def find_user_by_id(self, user_id):
        session = self.sessionmaker()
        user = session.query(User).get(user_id)

        return user

    def find_users(self, friends_of_user=None):
        session = self.sessionmaker()
        if friends_of_user:
            users = session.query(User).filter(User.user_id != friends_of_user)
        else:
            users = session.query(User).all()

        return [user for user in users]

    def create_user(self, user_id, username):
        user = User(user_id=user_id, username=username)

        session = self.sessionmaker()
        session.add(user)
        session.commit()

        return True

    def find_messages(self, inbox, marker=None):
        session = self.sessionmaker()

        if marker is None:
            messages = session.query(Message).all()
        else:
            last_time = datetime.datetime.fromtimestamp(marker)
            messages = session.query(Message).filter(Message.created_at >= last_time) # Pull strategy, hence the equal or greater than

        return [message for message in messages]

    def create_message(self, from_user, inbox, message):
        message = Message(from_user=from_user,
                          inbox=inbox,
                          text=message)
        session = self.sessionmaker()
        session.add(message)
        session.commit()

        session.refresh(message)

        return message

    def update_user(self, user_id, **kwargs):
        session = self.sessionmaker()
        user = session.query(User).get(user_id)

        if 'status' in kwargs:
            user.status = kwargs['status']

        session.add(user)
        session.commit()
        return True