/*
 * MONGOOSE DATABASE.
 */

var ME            = module.exports;
var crypto        = require('crypto');
var logger        = require('log-ninja');
var mongoose      = require('mongoose');
var schemaBuilder = require('mongoose-schema-builder');
var extender      = require('object-extender');
var _             = require('underscore');

/*
 * List of stored database connections.
 */
ME.connectionsList = {};

/*
 * Returns the database connection for the given ID.
 */
ME.use = function (dbId) {

  // If the connection doesn't exist yet, create an empty object ready for it.
  if (_.isUndefined(ME.connectionsList[dbId])) {
    ME.connectionsList[dbId] = {};
  }

  return ME.connectionsList[dbId];

};

/*
 * Stores a reference to a database connection for later use.
 */
ME.store = function (dbId, dbObj) {

  // No reference exists yet, store this as an entirely new reference.
  if (_.isUndefined(ME.connectionsList[dbId])) {
    ME.connectionsList[dbId] = dbObj;
  }

  // Update the existing reference.
  else {
    ME.connectionsList[dbId] = extender.extend(true, ME.connectionsList[dbId], dbObj);
  }

};

/*
 * Generates a unique random ID to use for a database connection.
 */
ME.generateDBId = function () {

  var seed  = new Date().getTime() + Math.random();
  var algo  = crypto.createHash('sha256');
  var value = 'hash-' + seed;

  algo.update(value, 'utf8');
  return algo.digest('hex');

};

/*
 * Create a new instance of the database class.
 * [options]
 *  schema      (str/obj)    Either the absolute path to a schema file OR a schema object.
 *  credentials (string)     A MongoDB connection string.
 *  debug       (bool>false) Set true to manually enable Mongoose debug output.
 */
function Connection (options) {

  // Default option values.
  options = extender.defaults({
    dbId:        null,
    schema:      null,
    credentials: null,
    replicas:    null,
    debug:       false
  }, options);

  // Always ensure we have a dbId.
  if (!options.dbId || !_.isString(options.dbId)) {
    options.dbId = ME.generateDBId();
  }

  // Variables for this instance.
  this.dbId              = options.dbId;
  this.schema            = options.schema;
  this.credentials       = options.credentials;
  this.replicas          = (options.replicas && typeof options.replicas === 'string' ? [options.replicas] : options.replicas);
  this.debug             = options.debug;
  this.conx              = null;
  this.isConnectedFlag   = false;
  this.onConnectHandlers = [];
  this.model             = {};

  // Store this connection.
  ME.store(options.dbId, this);

};

/*
 * [Re]builds the Mongoose schema from the short-hand JSON format.
 * callback(err);
 */
Connection.prototype.rebuildSchema = function (schema, callback) {
  if (typeof callback !== 'function') { callback = function(){}; }

  var that = this;  //keep reference to 'this' inside nested methods.

  // Convert the short-hand schema to Mongoose format.
  schemaBuilder.build(mongoose, schema, function (err, mongooseModels) {

    if (err) { return callback(err); }

    // Successfully merge in the models.
    that.model = extender.extend(that.model, mongooseModels);
    return callback(null);

  });

};

/*
 * Toggle Mongoose debug output.
 */
Connection.prototype.setDebug = function (debug) {
  this.debug = debug;
  mongoose.set('debug', debug);
};

/*
 * Connects and sets up the database ready for use.
 * callback(err, database)
 * handler(err, database)
 */
Connection.prototype.connect = function (callback) {

  var that = this;  //keep reference to 'this' inside nested methods.

  // Already connected!
  if (this.isConnectedFlag && typeof callback === 'function') {
    return callback(null, this);
  }

  // Build the schema for the first time.
  if (_.keys(this.model).length === 0) {
    this.rebuildSchema(this.schema, function (err) {
      if (err) { return callback(err); }
      return that.connect(callback);  //drop out of this method & re-enter from the top.
    });
    return;
  }

  // Add the primary callback, if any.
  if (typeof callback === 'function') {
    this.onConnectHandlers.unshift(callback);
  }

  // When debugging, this will output all calls mongoose makes.
  if (this.debug) { mongoose.set('debug', true); }

  var connectionString = this.credentials;

  // Prepare any replicas for connecting.
  if (this.replicas) { connectionString += ',' + this.replicas.join(','); }

  // Connect!
  mongoose.connect(connectionString);
  this.conx = mongoose.connection;

  // Prepare the method for passing details to each handler.
  var passToConnectionHandlers = function (err, handlers) {
    if (handlers && handlers.length > 0) {
      for (var h = 0 ; h < handlers.length ; h++) {
        if (typeof handlers[h] === 'function') { handlers[h](err, that); }
      }
    }
  };

  // Error handler, pass the error to all connection handlers.
  this.conx.on('error', function (err) {

    logger.error('Database Error!').error(err);

    that.isConnectedFlag = false;

    passToConnectionHandlers(err, that.onConnectHandlers);
    that.onConnectHandlers = [];

  });

  // Success handler, pass the database object to all connection handlers.
  this.conx.once('open', function () {

    that.isConnectedFlag = true;

    passToConnectionHandlers(null, that.onConnectHandlers);
    that.onConnectHandlers = [];

  });

  this.conx.on('connected', function () {
    that.isConnectedFlag = true;
  });

  this.conx.on('disconnected', function () {
    that.isConnectedFlag = false;
  });

};

/*
 * Disconnects from the database.
 * callback();
 */
Connection.prototype.disconnect = function (callback) {
  if (typeof callback !== 'function') { callback = function(){}; }

  var that = this;  //keep reference to 'this' inside nested methods.

  return mongoose.disconnect(function () {
    that.isConnectedFlag = false;
    return callback();
  });

};

/*
 * Stores a handler to be run when the connection is ready.
 * onConnectHandler(err, database);
 */
Connection.prototype.onConnected = function (fn) {
  if (typeof fn !== 'function') { return; }

  // Run it now if we are connected and all other connection handlers have been dealt with.
  if (this.isConnectedFlag && this.onConnectHandlers.length === 0) {
    return fn(null, this);
  }

  // Otherwise store it for later
  this.onConnectHandlers.push(fn);

};

/*
 * Returns true if the database is connected.
 */
Connection.prototype.isConnected = function () {
  return this.isConnectedFlag;
};

/*
 * Pushes an object ID into a given document's property array. The callback
 * parameter is optional.
 * callback(err, doc);
 */
Connection.prototype.pushReference = function (doc, fieldName, value, callback) {

  // Push onto arrays, for all other types replace the value.
  if (_.isArray(doc[fieldName])) { doc[fieldName].push(value); }
  else                           { doc[fieldName] = value; }

  doc.save(function (err) {
    return callback(err, doc);
  });

};

/*
 * Gets a single document by its ID alone.
 * callback(err, doc);
 */
Connection.prototype.getById = function (collectionName, id, callback) {

  // Setup query to return one item.
  this.model[collectionName].findOne({
    _id:                 id,
    'deleted.isDeleted': false
  })
  .exec(callback);

};

/*
 * Gets the maximum value of the given collection/field. If 'getting' param is
 * set to 'min' this will return the minimum value instead.
 * callback(err, maxValue, doc);
 */
Connection.prototype.getMax = function (collectionName, fieldName, conditions, callback, getting) {
  conditions = conditions || {};
  getting    = getting    || 'max';

  // Setup query to return one item.
  var query = this.model[collectionName].findOne(conditions);

  // Sort DESC (so we only find the top one).
  var operand = (getting === 'max' ? '-' : (getting === 'min' ? '+' : ''));
  query.sort(operand + fieldName);

  // No callback, return thr query instead.
  if (typeof callback !== 'function') { return query; }

  // Run the query and pass the max value to the callback.
  query.exec(function (err, doc) {
    var maxValue = (!err && doc ? doc[fieldName] : null);
    return callback(err, maxValue, doc);
  });

};

/*
 * Gets the minimum value of the given collection/field.
 * callback(err, minValue, doc);
 */
Connection.prototype.getMin = function (collectionName, fieldName, conditions, callback) {
  return this.getMax(collectionName, fieldName, conditions, callback, 'min');
};

/*
 * Counts the values in the given field(s). For integer/float fields the count
 * is incremented by the value, for string fields the count is incremented by 1.
 * The callback is passed a hash 'count' containing counters for each of the
 * given fields.
 * Alternatively if a falsy value is provided to 'fields' the method will
 * count the number of matching documents and will return a single integer.
 * [count:fields]
 *  fieldName1: 18
 *  fieldName2: 0
 *  fieldName3: 2
 * [count:documents]
 *  (returns integer)
 * callback(err, count);
 */
Connection.prototype.count = function (collectionName, fields, conditions, callback) {
  conditions = conditions || {};
  if (typeof fields === 'string') { fields = [fields]; }  //ensure fields is an array of strings.

  var mode  = (fields ? 'fields' : 'documents');
  var count = {};

  // Prepare for counting fields.
  if (mode === 'fields') {
    for (var f in fields) {
      var fieldName = fields[f];
      count[fieldName] = 0;
    }
  }

  // Setup query to return all matching documents.
  var query = this.model[collectionName].find(conditions);

  // Run the query and pass the max value to the callback.
  query.exec(function (err, docs) {

    if (err) { return callback(err); }

    // Counting documents, easy peasy.
    if (mode === 'documents') { return callback(null, docs.length); }

    // Cycle each document
    for (var d = 0, dlen = docs.length ; d < dlen ; d++) {
      var doc = docs[d];

      // Count each given field.
      for (var fieldName in count) {
        switch (typeof doc[fieldName]) {
          case 'number': count[fieldName] += doc[fieldName]; break;
          case 'string': count[fieldName] += 1;              break;
        }
      }

    }

    // Pass back
    return callback(null, count);

  });

};

/*
 * Returns a new object ID to be used when adding new documents (optional).
 */
ME.newObjectId = Connection.prototype.newObjectId = function () {
  return mongoose.Types.ObjectId();
};

/*
 * Returns true if the input string is likely to be an ObjectID.
 */
ME.isObjectId = Connection.prototype.isObjectId = function (input) {
  var regexp = new RegExp("^[0-9a-fA-F]{24}$");
  return regexp.test(input);
};

/*
 * Converts a string to an ObjectID.
 */
ME.toObjectId = Connection.prototype.toObjectId = function (input) {
  return mongoose.Types.ObjectId(input);
};

/*
 * Converts an array of object IDs to an array of strings.
 */
ME.objectIdArrayToString = Connection.prototype.objectIdArrayToString = function (input) {
  var newArr = [];
  for (var i = 0, ilen = input.length ; i < ilen ; i++) {
    newArr.push(input[i].toString());
  }
  return newArr;
};

/*
 * Returns true if the specified array contains the specified ObjectID.
 */
ME.containsObjectId = Connection.prototype.containsObjectId = function (arr, objectId, property) {
  if (typeof property === 'undefined') { property = '_id'; }

  var index = null;

  for (var i=0 ; i < arr.length ; i++) {
    var arrItem        = arr[i];
    var isItemObjectId = this.isObjectId(arrItem);
    var validObjectId  = false;
    var value;

    // Passed in an object.
    if (!isItemObjectId && typeof arrItem === 'object') {
      validObjectId = this.isObjectId(arrItem[property]);
      value         = arrItem[property];
    }

    // Passed in an array of object IDs.
    else {
      validObjectId = isItemObjectId;
      value         = arrItem;
    }

    // If the array element is an object Id the values are compared using the
    // MongoDB equals method, otherwise they are compared naturally.
    if (
      (validObjectId && value.equals(objectId)) ||
      (!validObjectId && value == objectId)   //use == not === as we can't be sure of the data types here [ e.g. "1" == 1 ].
    ) {
      index = i;
      break;
    }

  }

  return (index !== null);

};

/*
 * Add connection to module export.
 */

ME.Connection = Connection;