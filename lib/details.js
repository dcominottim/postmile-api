// Load modules

var Hapi = require('hapi');
var Task = require('./task');
var Last = require('./last');
var User = require('./user');


// Declare internals

var internals = {};


// Task details

exports.get = {
    validate: {
        query: {
            since: Hapi.types.Number().min(0)
        }
    },
    handler: function (request, reply) {

        var self = this;

        internals.load(this.db, request.params.id, request.auth.credentials.user, false, function (err, details, task, project) {

            details = details || { id: request.params.id, thread: [] };

            if (err) {
                return reply(err);
            }

            // Clear thread from old entries

            if (request.query.since) {
                var since = parseInt(request.query.since, 10);
                if (since &&
                    since > 0) {

                    var thread = [];
                    for (var i = 0, il = details.thread.length; i < il; ++i) {
                        if (details.thread[i].created > since) {
                            thread.push(details.thread[i]);
                        }
                    }

                    details.thread = thread;
                }
            }

            // Load user display information

            var userIds = [];
            for (i = 0, il = details.thread.length; i < il; ++i) {
                userIds.push(details.thread[i].user);
            }

            User.expandIds(self.db, userIds, function (users, usersMap) {

                // Assign to each thread item

                for (i = 0, il = details.thread.length; i < il; ++i) {
                    details.thread[i].user = usersMap[details.thread[i].user] || { id: details.thread[i].user };
                }

                return reply(details);
            });
        });
    }
};


// Add task detail

exports.post = {
    validate: {
        query: {
            last: Hapi.types.Boolean()
        },
        payload: {
            type: Hapi.types.String().required().valid('text'),
            content: Hapi.types.String().required()
        }
    },
    handler: function (request, reply) {

        var self = this;

        var now = Date.now();

        var post = function () {

            internals.load(self.db, request.params.id, request.auth.credentials.user, true, function (err, details, task, project) {

                if (err || !task) {
                    return reply(err);
                }

                var detail = request.payload;
                detail.created = now;
                detail.user = request.auth.credentials.user;

                if (details) {

                    // Existing details

                    self.db.update('task.details', details._id, { $push: { thread: detail } }, function (err) {

                        if (err) {
                            return reply(err);
                        }

                        finalize(task, project);
                    });
                }
                else {

                    // First detail

                    details = { _id: task._id, project: project._id, thread: [] };
                    details.thread.push(detail);

                    self.db.insert('task.details', details, function (err, items) {

                        if (err) {
                            return reply(err);
                        }

                        finalize(task, project);
                    });
                }
            });
        };

        var finalize = function (task, project) {

            if (request.query.last === 'true') {
                Last.setLast(request.auth.credentials.user, project, task, function (err) { });    // Ignore response
            }

            self.streamer.update({ object: 'details', project: task.project, task: task._id }, request);
            return reply({ status: 'ok' });
        };

        post();
    }
};


// Get details quick list

exports.expandIds = function (db, ids, projectId, userId, callback) {

    db.getMany('task.details', ids, function (err, items, notFound) {

        if (err) {
            return callback([]);
        }

        Last.load(db, userId, function (err, last) {

            var records = {};
            var userIds = [];
            for (var i = 0, il = items.length; i < il; ++i) {
                var details = items[i];
                var threadHead = (details.thread && details.thread.length > 0 ? details.thread[details.thread.length - 1] : null);
                if (threadHead) {
                    records[details._id] = { modified: threadHead.created, user: threadHead.user };
                    userIds.push(threadHead.user);

                    if (last &&
                        last.projects &&
                        last.projects[projectId] &&
                        last.projects[projectId].tasks &&
                        last.projects[projectId].tasks[details._id]) {

                        records[details._id].last = last.projects[projectId].tasks[details._id];
                    }
                }
            }

            // Load user display information

            User.expandIds(db, userIds, function (users, usersMap) {

                // Assign to each thread item

                for (var i in records) {
                    if (records.hasOwnProperty(i)) {
                        records[i].user = usersMap[records[i].user] || { id: records[i].user };
                    }
                }

                return callback(records);
            });
        });
    });
};


// Load task from database and check for user rights

internals.load = function (db, taskId, userId, isWritable, callback) {

    Task.load(db, taskId, userId, isWritable, function (err, task, project) {      // Check ownership

        if (err || !task) {
            return callback(err);
        }

        db.get('task.details', taskId, function (err, item) {

            if (err) {
                return callback(err);
            }

            if (!item) {
                return callback(null, null, task, project);
            }

            return callback(null, item, task, project);
        });
    });
};

