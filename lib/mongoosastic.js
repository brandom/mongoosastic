var elasticsearch = require('elasticsearch'),
  Generator = require('./mapping-generator'),
  generator = new Generator(),
  serialize = require('./serialize'),
  events = require('events'),
  nop = require('nop'),
  util = require('util');

module.exports = function Mongoosastic(schema, options) {
  options = options || {};

  var bulkTimeout, bulkBuffer = [], esClient,
    mapping = getMapping(schema),
    flatten = getFlatten(schema),
    indexName = options && options.index,
    typeName = options && options.type,
    alwaysHydrate = options && options.hydrate,
    defaultHydrateOptions = options && options.hydrateOptions,
    bulk = options && options.bulk,
    filter = options && options.filter;

  if (options.esClient) {
    esClient = options.esClient;
  } else {
    esClient = createEsClient(options);
  }

  setUpMiddlewareHooks(schema);

  /**
   * ElasticSearch Client
   */
  schema.statics.esClient = esClient;

  /**
   * Create the mapping. Takes an optional settings parameter and a callback that will be called once
   * the mapping is created

   * @param settings Object (optional)
   * @param cb Function
   */
  schema.statics.createMapping = function(settings, cb) {
    if (arguments.length < 2) {
      cb = arguments[0] || nop;
      settings = undefined;
    }

    setIndexNameIfUnset(this.modelName);

    createMappingIfNotPresent({
      client: esClient,
      indexName: indexName,
      typeName: typeName,
      schema: schema,
      settings: settings
    }, cb);
  };

  /**
   * @param options  Object (optional)
   * @param cb Function
   */
  schema.methods.index = function(options, cb) {
    if (arguments.length < 2) {
      cb = arguments[0] || nop;
      options = {};
    }

    if (filter && filter(this)) {
      return cb();
    }

    setIndexNameIfUnset(this.constructor.modelName);

    var index = options.index || indexName,
      type = options.type || typeName;
      
    var indexObject = {
      index: index,
      type: type,
      id: this._id.toString(),
      refresh: true
    };
    
    if (flatten) {
      this.populate(flatten, function(err, doc) {
        indexObject.body = serialize(doc, mapping);
        createIndex(indexObject, cb);
      });
    } else {
      indexObject.body = serialize(this, mapping);
      createIndex(indexObject, cb);
    }
  };
  
  function createIndex (indexObject, cb) {
    esClient.index(indexObject, cb);
  }

  /**
   * Unset elasticsearch index
   * @param options - (optional) options for unIndex
   * @param cb - callback when unIndex is complete
   */
  schema.methods.unIndex = function(options, cb) {
    if (arguments.length < 2) {
      cb = arguments[0] || nop;
      options = {};
    }

    setIndexNameIfUnset(this.constructor.modelName);

    options.index = options.index || indexName;
    options.type = options.type || typeName;
    options.model = this;
    options.client = esClient;
    options.tries = 3;

    if (bulk)
      bulkDelete(options, cb);
    else
      deleteByMongoId(options, cb);
  };

  /**
   * Delete all documents from a type/index
   * @param options - (optional) specify index/type
   * @param cb - callback when truncation is complete
   */
  schema.statics.esTruncate = function(options, cb) {
    if (arguments.length < 2) {
      cb = arguments[0] || nop;
      options = {};
    }

    setIndexNameIfUnset(this.modelName);

    var index = options.index || indexName,
      type = options.type || typeName;

    esClient.deleteByQuery({
      index: index,
      type: type,
      body: {
        query: {
          match_all: {}
        }
      }
    }, cb);
  };
  
  schema.statics.dropIndex = function(cb) {
    setIndexNameIfUnset(this.modelName);
    
    var index = options.index || indexName;
    
    esClient.indices.exists({index: index}, function(err, exists) {
      if (exists) esClient.indices.delete({index: index}, cb);
      else cb(null, exists);
    });
  };

  /**
   * Synchronize an existing collection
   *
   * @param query - query for documents you want to synchronize
   */
  schema.statics.synchronize = function(query) {
    var em = new events.EventEmitter(),
      bulkSize = 1000,
      bulkCommand = [],
      counter = 0;

    query = query || {};

    setIndexNameIfUnset(this.modelName);
    
    var syncQuery = this.find(query);
    if (flatten) syncQuery.populate(flatten);
    var stream = syncQuery.stream();

    stream.on('data', function(doc) {
      
      if (filter && filter(doc)) {
        return em.emit('filter', doc);
      }
      
      counter++;
      
      bulkCommand.push({
        index: {
          _index: indexName,
          _type: typeName,
          _id: doc._id.toString(),
        }
      });
      bulkCommand.push(serialize(doc.toObject(), mapping));
      
      if (bulkCommand.length === bulkSize * 2) {
        stream.pause();
        esClient.bulk({body: bulkCommand}, function(err, result) {
          if (result.error) {
            em.emit('error', result);
          }
          bulkCommand = [];
          stream.resume();
        });
      }
      
    });

    stream.on('close', function() {
      if (bulkCommand.length < 1) {
        em.emit('close');
      } else {
        esClient.bulk({body: bulkCommand}, function(err, result) {
          if (result.error) {
            em.emit('error', result);
          }
          bulkCommand = [];
          em.emit('close');
        });
      }
    });

    stream.on('error', function(err) {
      em.emit('error', err);
    });

    return em;
  };
  /**
   * ElasticSearch search function
   *
   * @param query - query object to perform search with
   * @param options - (optional) special search options, such as hydrate
   * @param cb - callback called with search results
   */
  schema.statics.search = function(query, options, cb) {
    if (arguments.length === 2) {
      cb = arguments[1];
      options = {};
    }

    options.hydrateOptions = options.hydrateOptions || defaultHydrateOptions || {};

    if (query === null)
      query = undefined;
      
    setIndexNameIfUnset(this.modelName);      

    var _this = this,
      esQuery = {
        body: {
          query: query
        },
        index: options.index || indexName,
        type: options.type || typeName
      };
    if (options.highlight) {
      esQuery.body.highlight = options.highlight;
    }

    Object.keys(options).forEach(function(opt) {
      if (!opt.match(/hydrate/) && options.hasOwnProperty(opt))
        esQuery.body[opt] = options[opt];
    });

    esClient.search(esQuery, function(err, res) {
      if (err) {
        return cb(err);
      }

      if (alwaysHydrate || options.hydrate) {
        hydrate(res, _this, options, cb);
      } else {
        cb(null, res);
      }
    });
  };

  schema.statics.esCount = function(query, cb) {
    setIndexNameIfUnset(this.modelName);

    if (cb == null && typeof query === 'function') {
      cb = query;
      query = null;
    }

    var esQuery = {
      body: {
        query: query
      },
      index: options.index || indexName,
      type:  options.type  || typeName
    };

    esClient.count(esQuery, cb);
  };

  function bulkDelete(options, cb) {
    bulkAdd({
      delete: {
        _index: options.index || indexName,
        _type: options.type || typeName,
        _id: options.model._id.toString()
      }
    });
    cb();
  }

  function bulkIndex(options) {
    bulkAdd({
      index: {
        _index: options.index || indexName,
        _type: options.type || typeName,
        _id: options.model._id.toString()
      }
    });
    bulkAdd(options.model);
  }

  function clearBulkTimeout() {
    clearTimeout(bulkTimeout);
    bulkTimeout = undefined;
  }

  function bulkAdd(instruction) {
    bulkBuffer.push(instruction);

    //Return because we need the doc being indexed
    //Before we start inserting
    if (instruction.index && instruction.index._index)
      return;

    if (bulkBuffer.length >= (bulk.size || 1000)) {
      schema.statics.flush();
      clearBulkTimeout();
    } else if (bulkTimeout === undefined) {
      bulkTimeout = setTimeout(function() {
        schema.statics.flush();
        clearBulkTimeout();
      }, bulk.delay || 1000);
    }
  }

  schema.statics.flush = function(cb) {
    cb = cb || function(err) {
      if (err) {
        console.log(err);
      }
    };

    esClient.bulk({
      body: bulkBuffer
    }, cb);

    bulkBuffer = [];
  };

  schema.statics.refresh = function(options, cb) {
    if (arguments.length < 2) {
      cb = arguments[0] || nop;
      options = {};
    }

    setIndexNameIfUnset(this.modelName);
    esClient.indices.refresh({
      index: options.index || indexName
    }, cb);
  };

  function setIndexNameIfUnset(model) {
    var modelName = model.toLowerCase();
    if (!indexName) {
      indexName = modelName + 's';
    }

    if (!typeName) {
      typeName = modelName;
    }
  }

  /**
   * Use standard Mongoose Middleware hooks
   * to persist to Elasticsearch
   */
  function setUpMiddlewareHooks(schema) {
    schema.post('remove', function(doc) {
      setIndexNameIfUnset(doc.constructor.modelName);

      var options = {
        index: indexName,
        type: typeName,
        tries: 3,
        model: doc,
        client: esClient
      };

      if (bulk) {
        bulkDelete(options, nop);
      } else {
        deleteByMongoId(options, nop);
      }
    });

    /**
     * Save in elasticsearch on save.
     */

    schema.post('save', function(doc) {
      doc.index(function(err, res) {
        if (!filter || !filter(doc)) {
          doc.emit('es-indexed', err, res);
        }
      });
    });
  }

};

function createEsClient(options) {

  var esOptions = {};

  if (util.isArray(options.hosts)) {
    esOptions.host = options.hosts;
  } else {
    esOptions.host = {
      host: options && options.host ? options.host : 'localhost',
      port: options && options.port ? options.port : 9200,
      protocol: options && options.protocol ? options.protocol : 'http',
      auth: options && options.auth ? options.auth : null,
      keepAlive: false
    };
  }

  esOptions.log = (options ? options.log : null);

  return new elasticsearch.Client(esOptions);
}

function createMappingIfNotPresent(options, cb) {
  var client = options.client,
    indexName = options.indexName,
    typeName = options.typeName,
    schema = options.schema,
    settings = options.settings;

  generator.generateMapping(schema, function(err, mapping) {
    var completeMapping = {};
    completeMapping[typeName] = mapping;
    client.indices.exists({index: indexName}, function(err, exists) {
      if (err) {
        return cb(err);
      }

      if (exists) {
        client.indices.putMapping({
          index: indexName,
          type: typeName,
          body: completeMapping
        }, cb);

      } else {
        client.indices.create({index: indexName, body: settings}, function(err) {
          if (err)
            return cb(err);

          client.indices.putMapping({
            index: indexName,
            type: typeName,
            body: completeMapping
          }, cb);
        });
      }
    });
  });
}

function hydrate(res, model, options, cb) {
  var results = res.hits,
    resultsMap = {},
    ids = results.hits.map(function(a, i) {
      resultsMap[a._id] = i;
      return a._id;
    }),

    query = model.find({_id: {$in: ids}}),
    hydrateOptions = options.hydrateOptions;

  // Build Mongoose query based on hydrate options
  // Example: {lean: true, sort: '-name', select: 'address name'}
  Object.keys(hydrateOptions).forEach(function(option) {
    query[option](hydrateOptions[option]);
  });

  query.exec(function(err, docs) {
    if (err) {
      return cb(err);
    } else {
      var hits = [];

      docs.forEach(function(doc) {
        var i = resultsMap[doc._id];
        if (options.highlight) {
          doc._highlight = results.hits[i].highlight;
        }

        hits[i] = doc;
      });

      results.hits = hits;
      res.hits = results;
      cb(null, res);
    }
  });
}

function getMapping(schema) {
  var retMapping = {};
  generator.generateMapping(schema, function(err, mapping) {
    retMapping = mapping;
  });

  return retMapping;
}

function getFlatten(schema) {
  var populatePaths = [];
  schema.eachPath(function(path, type) {
    if (type.options.flatten || (type.caster && type.caster.options && type.caster.options.flatten)) {
      var paths = type.options.flatten || type.caster.options.flatten || undefined;
      if (paths === true) paths = ' ';
      populatePaths.push({path: path, select: paths});
    }
  });
  return (populatePaths.length > 0) ? populatePaths : false;
}

function deleteByMongoId(options, cb) {
  var index = options.index,
    type = options.type,
    client = options.client,
    model = options.model,
    tries = options.tries;

  client.delete({
    index: index,
    type: type,
    id: model._id.toString()
  }, function(err, res) {
    if (err && err.message.indexOf('404') > -1) {
      setTimeout(function() {
        if (tries <= 0) {
          return cb(err);
        } else {
          options.tries = --tries;
          deleteByMongoId(options, cb);
        }
      }, 500);
    } else {
      model.emit('es-removed', err, res);
      cb(err);
    }
  });
}
