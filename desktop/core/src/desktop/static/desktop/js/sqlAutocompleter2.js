// Licensed to Cloudera, Inc. under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  Cloudera, Inc. licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

(function (root, factory) {
  if (typeof define === "function" && define.amd) {
    define([
      'desktop/js/autocomplete/sql',
      'desktop/js/sqlFunctions'
    ], factory);
  } else {
    root.SqlAutocompleter2 = factory(sql, sqlFunctions);
  }
}(this, function (sqlParser, sqlFunctions) {

  var IDENTIFIER_REGEX = /[a-zA-Z_0-9\$\u00A2-\uFFFF]/;

  /**
   * @param {Object} options
   * @param {Snippet} options.snippet
   * @param {Number} options.timeout
   * @constructor
   */
  function SqlAutocompleter2(options) {
    var self = this;
    self.snippet = options.snippet;
    self.timeout = options.timeout;
  }

  // Keyword weights come from the parser
  var DEFAULT_WEIGHTS = {
    COLUMN: 700,
    VIRTUAL_COLUMN: 600,
    SAMPLE: 500,
    IDENTIFIER: 400,
    CTE: 300,
    TABLE: 200,
    DATABASE: 100,
    HDFS: 1,
    COLREF_KEYWORD: -1
  };

  SqlAutocompleter2.prototype.autocomplete = function (beforeCursor, afterCursor, callback, editor) {
    var self = this;
    var parseResult = sqlParser.parseSql(beforeCursor, afterCursor, self.snippet.type(), sqlFunctions, false);

    var deferrals = [];
    var completions = [];
    var columnSuggestions = [];

    if (parseResult.suggestKeywords) {
      parseResult.suggestKeywords.forEach(function (keyword) {
        completions.push({
          value: parseResult.lowerCase ? keyword.value.toLowerCase() : keyword.value,
          meta: 'keyword',
          weight: keyword.weight
        });
      });
    }

    if (parseResult.suggestIdentifiers) {
      parseResult.suggestIdentifiers.forEach(function (identifier) {
        completions.push({value: identifier.name, meta: identifier.type, weight: DEFAULT_WEIGHTS.IDENTIFIER });
      });
    }

    if (parseResult.suggestCommonTableExpressions) {
      parseResult.suggestCommonTableExpressions.forEach(function (expression) {
        var prefix = expression.prependQuestionMark ? '? ' : '';
        if (expression.prependFrom) {
          prefix += parseResult.lowerCase ? 'from ' : 'FROM ';
        }
        completions.push({value: prefix + expression.name, meta: 'CTE', weight: DEFAULT_WEIGHTS.CTE });
      });
    }

    var database = parseResult.useDatabase || self.snippet.database();

    var colRefDeferral = $.Deferred();
    deferrals.push(colRefDeferral);
    var colRef = null;

    if (parseResult.colRef) {
      var colRefCallback = function (data) {
        colRef = data;
        colRefDeferral.resolve();
      };

      var foundVarRef = parseResult.colRef.identifierChain.filter(function (identifier) {
        return identifier.name.indexOf('${') === 0;
      });

      if (foundVarRef.length > 0) {
        colRefCallback({ type: 'T' });
      } else {
        self.fetchFieldsForIdentifiers(editor, parseResult.colRef.table, parseResult.colRef.database || database, parseResult.colRef.identifierChain, colRefCallback, colRefDeferral.resolve);
      }

    } else {
      colRefDeferral.resolve();
    }

    if (parseResult.suggestFunctions) {
      var suggestFunctionsDeferral = $.Deferred();
      if (parseResult.suggestFunctions.types && parseResult.suggestFunctions.types[0] === 'COLREF') {
        $.when.apply($, colRefDeferral).done(function () {
          if (colRef !== null) {
            sqlFunctions.suggestFunctions(self.snippet.type(), [colRef.type.toUpperCase()], parseResult.suggestAggregateFunctions || false, parseResult.suggestAnalyticFunctions || false, completions);
          } else {
            sqlFunctions.suggestFunctions(self.snippet.type(), ['T'], parseResult.suggestAggregateFunctions || false, parseResult.suggestAnalyticFunctions || false, completions);
          }
          suggestFunctionsDeferral.resolve();
        });
      } else {
        sqlFunctions.suggestFunctions(self.snippet.type(), parseResult.suggestFunctions.types || ['T'], parseResult.suggestAggregateFunctions || false, parseResult.suggestAnalyticFunctions || false, completions);
        suggestFunctionsDeferral.resolve();
      }
      deferrals.push(suggestFunctionsDeferral);
    }

    if (parseResult.suggestValues) {
      var suggestValuesDeferral = $.Deferred();
      $.when.apply($, colRefDeferral).done(function () {
        if (colRef !== null) {
          self.addValues(colRef, completions);
        }
        suggestValuesDeferral.resolve();
      });
      deferrals.push(suggestValuesDeferral);
    }

    if (parseResult.suggestColRefKeywords) {
      var suggestColRefKeywordsDeferral = $.Deferred();
      $.when.apply($, colRefDeferral).done(function () {
        if (colRef !== null) {
          self.addColRefKeywords(parseResult, colRef.type, completions);
        }
        suggestColRefKeywordsDeferral.resolve();
      });
      deferrals.push(suggestColRefKeywordsDeferral);
    }

    if (parseResult.suggestColumns) {
      var suggestColumnsDeferral =  $.Deferred();
      if (parseResult.suggestColumns.types && parseResult.suggestColumns.types[0] === 'COLREF') {
        $.when.apply($, colRefDeferral).done(function () {
          parseResult.suggestColumns.tables.forEach(function (table) {
            if (colRef !== null) {
              deferrals.push(self.addColumns(parseResult, table, editor, database, [colRef.type.toUpperCase()], columnSuggestions));
            } else {
              deferrals.push(self.addColumns(parseResult, table, editor, database, ['T'], columnSuggestions));
            }
          });
          suggestColumnsDeferral.resolve();
        });
      } else {
        parseResult.suggestColumns.tables.forEach(function (table) {
          deferrals.push(self.addColumns(parseResult, table, editor, database, parseResult.suggestColumns.types || ['T'], columnSuggestions));
        });
        suggestColumnsDeferral.resolve();
      }
      if (typeof parseResult.suggestColumns.identifierChain === 'undefined' && self.snippet.type() === 'hive') {
        completions.push({value: 'BLOCK__OFFSET__INSIDE__FILE', meta: 'virtual', weight: DEFAULT_WEIGHTS.VIRTUAL_COLUMN});
        completions.push({value: 'INPUT__FILE__NAME', meta: 'virtual', weight: DEFAULT_WEIGHTS.VIRTUAL_COLUMN});
      }
      deferrals.push(suggestColumnsDeferral);
    }

    if (parseResult.suggestDatabases) {
      deferrals.push(self.addDatabases(parseResult, completions));
    }

    if (parseResult.suggestHdfs) {
      deferrals.push(self.addHdfs(parseResult, editor, completions));
    }

    if (parseResult.suggestTables) {
      deferrals.push(self.addTables(parseResult, editor, database, completions))
    }

    $.when.apply($, deferrals).done(function () {
      columnSuggestions.sort(function (a, b) {
        return a.value.localeCompare(b.value);
      });

      for (var i = 0; i < columnSuggestions.length; i++) {
        var suggestion = columnSuggestions[i];
        if (i + 1 < columnSuggestions.length) {
          var nextSuggestion = columnSuggestions[i + 1];
          if (suggestion.value === nextSuggestion.value) {
            if (suggestion.table.alias) {
              suggestion.value = suggestion.table.alias + '.' + suggestion.value;
            } else {
              suggestion.value = suggestion.table.table + '.' + suggestion.value;
            }
            if (nextSuggestion.table.alias) {
              nextSuggestion.value = nextSuggestion.table.alias + '.' + nextSuggestion.value;
            } else {
              nextSuggestion.value = nextSuggestion.table.table + '.' + nextSuggestion.value;
            }
          }
        }
        if (suggestion.table.alias && suggestion.value.indexOf(suggestion.table.alias) !== 0) {
          suggestion.value = suggestion.table.alias + '.' + suggestion.value;
        }
        delete suggestion.table;
      }
      completions = completions.concat(columnSuggestions);
      self.finalizeCompletions(completions, callback, editor);
    });
  };

  SqlAutocompleter2.prototype.addValues = function (columnReference, completions) {
    if (columnReference.sample) {
      var isString = columnReference.type === "string";
      columnReference.sample.forEach(function (sample) {
        completions.push({meta: 'value', value: isString ? "'" + sample + "'" : new String(sample), weight: DEFAULT_WEIGHTS.SAMPLE })
      });
    }
  };

  SqlAutocompleter2.prototype.addColRefKeywords = function (parseResult, type, completions) {
    var self = this;
    Object.keys(parseResult.suggestColRefKeywords).forEach(function (typeForKeywords) {
      if (sqlFunctions.matchesType(self.snippet.type(), [typeForKeywords], [type.toUpperCase()])) {
        parseResult.suggestColRefKeywords[typeForKeywords].forEach(function (keyword) {
          completions.push({
            value: parseResult.lowerCase ? keyword.toLowerCase() : keyword,
            meta: 'keyword',
            weight: DEFAULT_WEIGHTS.COLREF_KEYWORD
          });
        })
      }
    });
  };

  SqlAutocompleter2.prototype.fetchFieldsForIdentifiers = function (editor, tableName, databaseName, identifierChain, callback, errorCallback, fetchedFields) {
    var self = this;
    if (!fetchedFields) {
      fetchedFields = [];
    }
    if (!identifierChain) {
      identifierChain = [];
    }
    if (identifierChain.length > 0) {
      fetchedFields.push(identifierChain[0].name);
      identifierChain = identifierChain.slice(1);
    }

    // Parser sometimes knows if it's a map or array.
    if (identifierChain.length > 0 && (identifierChain[0].name === 'item' || identifierChain[0].name === 'value')) {
      fetchedFields.push(identifierChain[0].name);
      identifierChain = identifierChain.slice(1);
    }

    self.snippet.getApiHelper().fetchFields({
      sourceType: self.snippet.type(),
      databaseName: databaseName,
      tableName: tableName,
      fields: fetchedFields,
      editor: editor,
      timeout: self.timeout,
      successCallback: function (data) {
        if (identifierChain.length > 0) {
          if (data.type === 'array') {
            fetchedFields.push('item')
          }
          if (data.type === 'map') {
            fetchedFields.push('value')
          }
          self.fetchFieldsForIdentifiers(editor, tableName, databaseName, identifierChain, callback, errorCallback, fetchedFields)
        } else {
          callback(data);
        }
      },
      silenceErrors: true,
      errorCallback: errorCallback
    });
  };

  SqlAutocompleter2.prototype.addTables = function (parseResult, editor, database, completions) {
    var self = this;
    var tableDeferred = $.Deferred();
    var prefix = parseResult.suggestTables.prependQuestionMark ? '? ' : '';
    if (parseResult.suggestTables.prependFrom) {
      prefix += parseResult.lowerCase ? 'from ' : 'FROM ';
    }

    self.snippet.getApiHelper().fetchTables({
      sourceType: self.snippet.type(),
      databaseName: parseResult.suggestTables.database || database,
      successCallback: function (data) {
        data.tables_meta.forEach(function (tablesMeta) {
          if (parseResult.suggestTables.onlyTables && tablesMeta.type.toLowerCase() !== 'table' ||
              parseResult.suggestTables.onlyViews && tablesMeta.type.toLowerCase() !== 'view') {
            return;
          }
          completions.push({
            value: prefix + self.backTickIfNeeded(tablesMeta.name),
            meta: tablesMeta.type.toLowerCase(),
            weight: DEFAULT_WEIGHTS.TABLE
          })
        });
        tableDeferred.resolve();
      },
      silenceErrors: true,
      errorCallback: tableDeferred.resolve,
      editor: editor,
      timeout: self.timeout
    });
    return tableDeferred;
  };

  SqlAutocompleter2.prototype.locateSubQuery = function (subQueries, subQueryName) {
    var foundSubQueries = subQueries.filter(function (knownSubQuery) {
      return knownSubQuery.alias === subQueryName
    });
    if (foundSubQueries.length > 0) {
      return foundSubQueries[0];
    }
    return null;
  };

  SqlAutocompleter2.prototype.addColumns = function (parseResult, table, editor, database, types, columnSuggestions) {
    var self = this;
    var addColumnsDeferred = $.Deferred();

    if (table.subQuery && !table.identifierChain) {
      var foundSubQuery = self.locateSubQuery(parseResult.subQueries, table.subQuery);

      var addSubQueryColumns = function (subQueryColumns) {
        subQueryColumns.forEach(function (column) {
          if (column.alias || column.identifierChain) {
            // TODO: Potentially fetch column types for sub-queries, possible performance hit.
            var type = typeof column.type !== 'undefined' && column.type !== 'COLREF' ? column.type : 'T';
            if (column.alias) {
              columnSuggestions.push({value: self.backTickIfNeeded(column.alias), meta: type, weight: DEFAULT_WEIGHTS.COLUMN, table: table })
            } else if (column.identifierChain && column.identifierChain.length === 1) {
              columnSuggestions.push({value: self.backTickIfNeeded(column.identifierChain[0].name), meta: type, weight: DEFAULT_WEIGHTS.COLUMN, table: table })
            }
            addColumnsDeferred.resolve();
            return addColumnsDeferred;
          } else if (column.subQuery && foundSubQuery.subQueries) {
            var foundNestedSubQuery = self.locateSubQuery(foundSubQuery.subQueries, column.subQuery);
            if (foundNestedSubQuery !== null) {
              addSubQueryColumns(foundNestedSubQuery.columns);
            }
          }
        });
      };
      if (foundSubQuery !== null) {
        addSubQueryColumns(foundSubQuery.columns);
      }
    } else {
      var callback = function (data) {
        if (data.extended_columns) {
          data.extended_columns.forEach(function (column) {
            if (column.type.indexOf('map') === 0 && self.snippet.type() === 'hive') {
              columnSuggestions.push({value: self.backTickIfNeeded(column.name) + '[]', meta: 'map', weight: DEFAULT_WEIGHTS.COLUMN, table: table })
            } else if (column.type.indexOf('map') === 0) {
              columnSuggestions.push({value: self.backTickIfNeeded(column.name), meta: 'map', weight: DEFAULT_WEIGHTS.COLUMN, table: table })
            } else if (column.type.indexOf('struct') === 0) {
              columnSuggestions.push({value: self.backTickIfNeeded(column.name), meta: 'struct', weight: DEFAULT_WEIGHTS.COLUMN, table: table })
            } else if (column.type.indexOf('array') === 0 && self.snippet.type() === 'hive') {
              columnSuggestions.push({value: self.backTickIfNeeded(column.name) + '[]', meta: 'array', weight: DEFAULT_WEIGHTS.COLUMN, table: table })
            } else if (column.type.indexOf('array') === 0) {
              columnSuggestions.push({value: self.backTickIfNeeded(column.name), meta: 'array', weight: DEFAULT_WEIGHTS.COLUMN, table: table })
            } else if (sqlFunctions.matchesType(self.snippet.type(), types, [column.type.toUpperCase()]) ||
                sqlFunctions.matchesType(self.snippet.type(), [column.type.toUpperCase()], types)) {
              columnSuggestions.push({value: self.backTickIfNeeded(column.name), meta: column.type, weight: DEFAULT_WEIGHTS.COLUMN, table: table })
            }
          });
        } else if (data.columns) {
          data.columns.forEach(function (column) {
            columnSuggestions.push({value: self.backTickIfNeeded(column), meta: 'column', weight: DEFAULT_WEIGHTS.COLUMN, table: table })
          });
        }
        if (data.type === 'map' && self.snippet.type() === 'impala') {
          columnSuggestions.push({value: 'key', meta: 'key', weight: DEFAULT_WEIGHTS.COLUMN, table: table });
          columnSuggestions.push({value: 'value', meta: 'value', weight: DEFAULT_WEIGHTS.COLUMN, table: table });
        }
        if (data.type === 'struct') {
          data.fields.forEach(function (field) {
            columnSuggestions.push({value: self.backTickIfNeeded(field.name), meta: field.type, weight: DEFAULT_WEIGHTS.COLUMN, table: table })
          });
        } else if (data.type === 'map' && (data.value && data.value.fields)) {
          data.value.fields.forEach(function (field) {
            if (sqlFunctions.matchesType(self.snippet.type(), types, [field.type.toUpperCase()]) ||
                sqlFunctions.matchesType(self.snippet.type(), [column.type.toUpperCase()], types)) {
              columnSuggestions.push({value: self.backTickIfNeeded(field.name), meta: field.type, weight: DEFAULT_WEIGHTS.COLUMN, table: table });
            }
          });
        } else if (data.type === 'array' && (data.item && data.item.fields)) {
          data.item.fields.forEach(function (field) {
            if ((field.type === 'array' || field.type === 'map')) {
              if (self.snippet.type() === 'hive') {
                columnSuggestions.push({value: self.backTickIfNeeded(field.name) + '[]', meta: field.type, weight: DEFAULT_WEIGHTS.COLUMN, table: table });
              } else {
                columnSuggestions.push({value: self.backTickIfNeeded(field.name), meta: field.type, weight: DEFAULT_WEIGHTS.COLUMN, table: table });
              }
            } else if (sqlFunctions.matchesType(self.snippet.type(), types, [field.type.toUpperCase()]) ||
                sqlFunctions.matchesType(self.snippet.type(), [column.type.toUpperCase()], types)) {
              columnSuggestions.push({value: self.backTickIfNeeded(field.name), meta: field.type, weight: DEFAULT_WEIGHTS.COLUMN, table: table });
            }
          });
        }
        addColumnsDeferred.resolve();
      };

      self.fetchFieldsForIdentifiers(editor, table.table, table.database || database, table.identifierChain, callback, addColumnsDeferred.resolve);
    }
    return addColumnsDeferred;
  };

  SqlAutocompleter2.prototype.addDatabases = function (parseResult, completions) {
    var self = this;
    var databasesDeferred = $.Deferred();
    var prefix = parseResult.suggestDatabases.prependQuestionMark ? '? ' : '';
    if (parseResult.suggestDatabases.prependFrom) {
      prefix += parseResult.lowerCase ? 'from ' : 'FROM ';
    }
    self.snippet.getApiHelper().loadDatabases({
      sourceType: self.snippet.type(),
      successCallback: function (data) {
        data.forEach(function (db) {
          completions.push({
            value: prefix + self.backTickIfNeeded(db) + (parseResult.suggestDatabases.appendDot ? '.' : ''),
            meta: 'database',
            weight: DEFAULT_WEIGHTS.DATABASE
          });
        });
        databasesDeferred.resolve();
      },
      silenceErrors: true,
      errorCallback: databasesDeferred.resolve
    });
    return databasesDeferred;
  };

  SqlAutocompleter2.prototype.addHdfs = function (parseResult, editor, completions) {
    var self = this;
    var hdfsDeferred = $.Deferred();
    var parts = parseResult.suggestHdfs.path.split('/');
    // Drop the first " or '
    parts.shift();
    // Last one is either partial name or empty
    parts.pop();

    self.snippet.getApiHelper().fetchHdfsPath({
      pathParts: parts,
      successCallback: function (data) {
        if (!data.error) {
          data.files.forEach(function (file) {
            if (file.name !== '..' && file.name !== '.') {
              completions.push({
                value: parseResult.suggestHdfs.path === '' ? '/' + file.name : file.name,
                meta: file.type,
                weight: DEFAULT_WEIGHTS.HDFS
              });
            }
          });
        }
        hdfsDeferred.resolve();
      },
      silenceErrors: true,
      errorCallback: hdfsDeferred.resolve,
      editor: editor,
      timeout: self.timeout
    });

    return hdfsDeferred;
  };

  SqlAutocompleter2.prototype.finalizeCompletions = function (completions, callback, editor) {
    var self = this;
    self.sortCompletions(completions);
    var currentScore = 1000;
    completions.forEach(function (completion) {
      completion.score = currentScore;
      completion.prioritizeScore = true;
      completion.identifierRegex = IDENTIFIER_REGEX;
      currentScore--;
    });

    // TODO Figure out why SELECT | FROM customers LATERAL VIEW explode(a) AS (b, c)
    if (typeof editor !== 'undefined') {
      editor.hideSpinner();
    }
    callback(completions);
  };

  SqlAutocompleter2.prototype.sortCompletions = function (completions) {
    completions.sort(function (a, b) {
      if (typeof a.weight !== 'undefined' && typeof b.weight !== 'undefined' && b.weight !== a.weight) {
        return b.weight - a.weight;
      } else if (typeof a.weight !== 'undefined' && typeof b.weight === 'undefined') {
        return -1;
      } else if (typeof b.weight !== 'undefined' && typeof a.weight === 'undefined') {
        return 1;
      }
      return a.value.localeCompare(b.value);
    });
  };

  SqlAutocompleter2.prototype.getDocTooltip = function (item) {

  };

  var hiveReservedKeywords = {
    ALL: true, ALTER: true, AND: true, ARRAY: true, AS: true, AUTHORIZATION: true, BETWEEN: true, BIGINT: true, BINARY: true, BOOLEAN: true, BOTH: true, BY: true, CASE: true, CAST: true, 
    CHAR: true, COLUMN: true, CONF: true, CREATE: true, CROSS: true, CUBE: true, CURRENT: true, CURRENT_DATE: true, CURRENT_TIMESTAMP: true, CURSOR: true, 
    DATABASE: true, DATE: true, DECIMAL: true, DELETE: true, DESCRIBE: true, DISTINCT: true, DOUBLE: true, DROP: true, ELSE: true, END: true, EXCHANGE: true, EXISTS: true, 
    EXTENDED: true, EXTERNAL: true, FALSE: true, FETCH: true, FLOAT: true, FOLLOWING: true, FOR: true, FROM: true, FULL: true, FUNCTION: true, GRANT: true, GROUP: true, 
    GROUPING: true, HAVING: true, IF: true, IMPORT: true, IN: true, INNER: true, INSERT: true, INT: true, INTERSECT: true, INTERVAL: true, INTO: true, IS: true, JOIN: true, LATERAL: true, 
    LEFT: true, LESS: true, LIKE: true, LOCAL: true, MACRO: true, MAP: true, MORE: true, NONE: true, NOT: true, NULL: true, OF: true, ON: true, OR: true, ORDER: true, OUT: true, OUTER: true, OVER: true, 
    PARTIALSCAN: true, PARTITION: true, PERCENT: true, PRECEDING: true, PRESERVE: true, PROCEDURE: true, RANGE: true, READS: true, REDUCE: true, 
    REGEXP: true, REVOKE: true, RIGHT: true, RLIKE: true, ROLLUP: true, ROW: true, ROWS: true, 
    SELECT: true, SET: true, SMALLINT: true, TABLE: true, TABLESAMPLE: true, THEN: true, TIMESTAMP: true, TO: true, TRANSFORM: true, TRIGGER: true, TRUE: true, 
    TRUNCATE: true, UNBOUNDED: true, UNION: true, UNIQUEJOIN: true, UPDATE: true, USER: true, USING: true, VALUES: true, VARCHAR: true, WHEN: true, WHERE: true, 
    WINDOW: true, WITH: true
  };

  var extraHiveReservedKeywords = {
    ASC: true, CLUSTER: true, DESC: true, DISTRIBUTE: true, FORMATTED: true, FUNCTION: true, INDEX: true, INDEXES: true, LIMIT: true, SCHEMA: true, SORT: true
  };

  var impalaReservedKeywords = {
    ADD: true, AGGREGATE: true, ALL: true, ALTER: true, AND: true, API_VERSION: true, AS: true, ASC: true, AVRO: true, BETWEEN: true, BIGINT: true, BINARY: true, BOOLEAN: true, BY: true, CACHED: true, CASE: true, CAST: true, CHANGE: true, CHAR: true, CLASS: true, CLOSE_FN: true,
    COLUMN: true, COLUMNS: true, COMMENT: true, COMPUTE: true, CREATE: true, CROSS: true, DATA: true, DATABASE: true, DATABASES: true, DATE: true, DATETIME: true, DECIMAL: true, DELIMITED: true, DESC: true, DESCRIBE: true, DISTINCT: true, DIV: true, DOUBLE: true, DROP: true, ELSE: true, END: true,
    ESCAPED: true, EXISTS: true, EXPLAIN: true, EXTERNAL: true, FALSE: true, FIELDS: true, FILEFORMAT: true, FINALIZE_FN: true, FIRST: true, FLOAT: true, FORMAT: true, FORMATTED: true, FROM: true, FULL: true, FUNCTION: true, FUNCTIONS: true, GROUP: true, HAVING: true, IF: true, IN: true, INCREMENTAL: true,
    INIT_FN: true, INNER: true, INPATH: true, INSERT: true, INT: true, INTEGER: true, INTERMEDIATE: true, INTERVAL: true, INTO: true, INVALIDATE: true, IS: true, JOIN: true, LAST: true, LEFT: true, LIKE: true, LIMIT: true, LINES: true, LOAD: true, LOCATION: true, MERGE_FN: true, METADATA: true,
    NOT: true, NULL: true, NULLS: true, OFFSET: true, ON: true, OR: true, ORDER: true, OUTER: true, OVERWRITE: true, PARQUET: true, PARQUETFILE: true, PARTITION: true, PARTITIONED: true, PARTITIONS: true, PREPARE_FN: true, PRODUCED: true, RCFILE: true, REAL: true, REFRESH: true, REGEXP: true, RENAME: true,
    REPLACE: true, RETURNS: true, RIGHT: true, RLIKE: true, ROW: true, SCHEMA: true, SCHEMAS: true, SELECT: true, SEMI: true, SEQUENCEFILE: true, SERDEPROPERTIES: true, SERIALIZE_FN: true, SET: true, SHOW: true, SMALLINT: true, STATS: true, STORED: true, STRAIGHT_JOIN: true, STRING: true, SYMBOL: true, TABLE: true,
    TABLES: true, TBLPROPERTIES: true, TERMINATED: true, TEXTFILE: true, THEN: true, TIMESTAMP: true, TINYINT: true, TO: true, TRUE: true, UNCACHED: true, UNION: true, UPDATE_FN: true, USE: true, USING: true, VALUES: true, VIEW: true, WHEN: true, WHERE: true, WITH: true,
  };

  SqlAutocompleter2.prototype.backTickIfNeeded = function (text) {
    var self = this;
    if (text.indexOf('`') === 0) {
      return text;
    }
    var upperText = text.toUpperCase();
    if (self.snippet.type() === 'hive' && (hiveReservedKeywords[upperText] || extraHiveReservedKeywords[upperText])) {
      return '`' + text + '`';
    } else if (self.snippet.type() === 'impala' && impalaReservedKeywords[upperText]) {
      return '`' + text + '`';
    } else if (impalaReservedKeywords[upperText] || hiveReservedKeywords[upperText] || extraHiveReservedKeywords[upperText]) {
      return '`' + text + '`';
    } else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(text)) {
      return '`' + text + '`';
    }
    return text;
  };

  return SqlAutocompleter2;
}));