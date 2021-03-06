import { normalize } from 'normalizr';
import invariant from 'invariant';
import { graphApi, handleFbError } from './fb';
import { dashboardApi, handleDashError } from './laravel';
import { makeAsyncActions } from './actionsMaker';
import { jsonPostConfig, deleteConfig, jsonPutConfig } from '../utils/http';
import { property, difference, uniq, set, without, pick, get, mapKeys, mapValues } from 'lodash';
import { mergeEntities, removeEntities } from './entities';
import Schemas from '../schemas';
import {
  LOAD_IMPORT_EVENTS_START,
  LOAD_IMPORT_EVENTS_COMPLETE,
  LOAD_IMPORT_EVENTS_FAILURE,
  IMPORT_EVENT_START,
  IMPORT_EVENT_COMPLETE,
  IMPORT_EVENT_FAILURE,
  SHOW_ALREADY_IMPORTED_EVENTS,
  HIDE_ALREADY_IMPORTED_EVENTS,
  SHOW_IMPORT_EVENTS_FULL_DESCRIPTION,
  SHOW_IMPORT_EVENTS_LESS_DESCRIPTION,
  DELETE_IMPORTED_EVENT_START,
  DELETE_IMPORTED_EVENT_COMPLETE,
  DELETE_IMPORTED_EVENT_FAILURE,
  RESYNC_IMPORTED_EVENT_START,
  RESYNC_IMPORTED_EVENT_COMPLETE,
  RESYNC_IMPORTED_EVENT_FAILURE,
  ADD_CATEGORY_TO_EVENT_REQUEST,
  ADD_CATEGORY_TO_EVENT_SUCCESS,
  ADD_CATEGORY_TO_EVENT_FAILURE,
  REMOVE_CATEGORY_FROM_EVENT_REQUEST,
  REMOVE_CATEGORY_FROM_EVENT_SUCCESS,
  REMOVE_CATEGORY_FROM_EVENT_FAILURE
} from '../constants/ActionTypes';

// Grab facebook events ids from links in reponse

const fbEventRe = /^https:\/\/www\.facebook\.com\/events\/([0-9]+)/;

const grabFbEventsIdsFromLinks = (links) => links.reduce((r, v) => {
  const matches = v ? v.match(fbEventRe) : false;
  return matches ? [...r, matches[1]] : r;
}, []);

// Normalize stuff...

const normalizeImportEvent = (event) => {
  const { entities, result } = normalize(event, Schemas.IMPORTED_EVENT);
  return { fbId: result, entities };
}

const normalizeImportEvents = (events) => {
  const { entities, result } = normalize(events, Schemas.IMPORTED_EVENT_ARRAY);
  return { fbIds: result, entities };
};

// Convert graph API facebook event to imported event...
const transformGraphFbEvent = (e) => ({
  fbid: e.id,
  fbAttendingCount: e.attendingCount,
  fbCoverImageUrl: get(e, 'cover.source'),
  placeName: get(e, 'place.name'),
  ...get(e, 'place.location', {}),
  ...pick(e, ['name', 'description', 'startTime', 'endTime']),
  categories: []
});

// Facebook event fields to pick for import...
const fbEventFields = ['name', 'description', 'start_time', 'end_time',
  'cover', 'place', 'attending_count'];

const fbEventsByIds = (fbids) => (dispatch, getState) =>
  dispatch(graphApi(`/?ids=${fbids.join(',')}&fields=${fbEventFields.join(',')}&pretty=0`))
    .then(data => mapValues(data, transformGraphFbEvent));

const fbEventById = (fbid) => (dispatch, getState) =>
  dispatch(graphApi(`/${fbid}?fields=${fbEventFields.join(',')}&pretty=0`))
    .then(transformGraphFbEvent);

const promiseForFreshFbEventById = (fbid) => (dispatch, getState) => {
  const fbEvent = getState().entities.fbEvents[fbid];
  return Promise.resolve(fbEvent || dispatch(fbEventById(fbid)));
};

const resetEventCategories = (e) => set(e, 'categories', []);

const importedEventsByFbIds = (fbids) => (dispatch, getState) =>
  dispatch(dashboardApi(`/events/fb?fbids=${fbids.join(',')}`))
    .then(normalizeImportEvents);

const getFbIdsToImport = (fbSourceId) => (dispatch, getState) => {
  const importUrl = getState().importEvents[fbSourceId].list.nextUrl || `/${fbSourceId}/posts?fields=link&pretty=0`;

  return dispatch(graphApi(importUrl))
    .then(response => {
      // List of ~~NEW~~ candidate facebook events ids to import
      const fbIdsToImport = difference(
        uniq(grabFbEventsIdsFromLinks(response.data.map(property('link')))),
        getState().importEvents.ids
      );

      // Import response pagination stuff...
      const paging = response.paging || {};

      return { fbIdsToImport, paging };
    });
};

export const addCategoryToEvent = (fbSourceId, fbid, categoryId) => {
  return (dispatch, getState) => {
    invariant(getState().categories.list.ids.indexOf(categoryId) !== -1,
      `Invalid category ${categoryId}`);
    const importedEvent = getState().entities.importedEvents[fbid];

    if (importedEvent) {
      const [ request, success, fail ] = makeAsyncActions({
        types: [
          ADD_CATEGORY_TO_EVENT_REQUEST,
          ADD_CATEGORY_TO_EVENT_SUCCESS,
          ADD_CATEGORY_TO_EVENT_FAILURE
        ],
        data: { fbSourceId, fbid }
      });

      dispatch(request());
      dispatch(dashboardApi(`/events/${importedEvent.id}/categories`, jsonPostConfig({
        categories: [categoryId]
      })))
      .then(() => {
        dispatch(mergeEntities({
          importedEvents: {
            [fbid]: {
              ...importedEvent,
              categories: [...importedEvent.categories, categoryId]
            }
          }
        }));
        dispatch(success());
      }, (r) => dispatch(fail(handleDashError(r))))
    } else {
      // Simply add category to entities of facebook event
      const fbEvent = getState().entities.fbEvents[fbid];
      invariant(fbEvent, `Invalid facebook id ${fbid} for adding category`);
      dispatch(mergeEntities({
        fbEvents: {
          [fbid]: {
            ...fbEvent,
            categories: [...fbEvent.categories, categoryId]
          }
        }
      }));
    }
  };
};

export const removeCategoryFromEvent = (fbSourceId, fbid, categoryId) => {
  return (dispatch, getState) => {
    invariant(getState().categories.list.ids.indexOf(categoryId) !== -1,
      `Invalid category ${categoryId}`);
    const importedEvent = getState().entities.importedEvents[fbid];

    if (importedEvent) {
      const [ request, success, fail ] = makeAsyncActions({
        types: [
          REMOVE_CATEGORY_FROM_EVENT_REQUEST,
          REMOVE_CATEGORY_FROM_EVENT_SUCCESS,
          REMOVE_CATEGORY_FROM_EVENT_FAILURE
        ],
        data: { fbSourceId, fbid }
      });

      dispatch(request());
      dispatch(dashboardApi(`/events/${importedEvent.id}/categories/${categoryId}`, deleteConfig()))
      .then(() => {
        dispatch(mergeEntities({
          importedEvents: {
            [fbid]: {
              ...importedEvent,
              categories: without(importedEvent.categories, categoryId)
            }
          }
        }));
        dispatch(success());
      }, (r) => dispatch(fail(handleDashError(r))))
    } else {
      // Simply remove category to entities of facebook event
      const fbEvent = getState().entities.fbEvents[fbid];
      invariant(fbEvent, `Invalid facebook id ${fbid} for removing category`);
      dispatch(mergeEntities({
        fbEvents: {
          [fbid]: {
            ...fbEvent,
            categories: without(fbEvent.categories, categoryId)
          }
        }
      }));
    }
  };
};

// ReSync imported event with facebook
export const reSyncImportedEvent = (fbSourceId, fbid) => {
  return (dispatch, getState) => {
    const importedEvent = getState().entities.importedEvents[fbid];
    invariant(importedEvent, `Invalid provided facebook id ${fbid} to remove.`);

    const [ start, complete, fail ] = makeAsyncActions({
      types: [
        RESYNC_IMPORTED_EVENT_START,
        RESYNC_IMPORTED_EVENT_COMPLETE,
        RESYNC_IMPORTED_EVENT_FAILURE
      ],
      data: { fbid, fbSourceId }
    });

    dispatch(start());
    dispatch(fbEventById(fbid)).then(e => resetEventCategories(e))
      .then(fbEvent => {
        dispatch(dashboardApi(`/events/fb/${fbid}`, jsonPutConfig(fbEvent)))
          .then(event => {
            dispatch(mergeEntities({
              ...normalizeImportEvent(event).entities,
              fbEvents: { [fbid]: fbEvent }
            }));
            dispatch(complete());
          }, (r) => dispatch(fail(handleDashError(r))));
      }, (r) => dispatch(fail(handleFbError(r))));
  };
};

// Delete imported event
export const deleteImportedEvent = (fbSourceId, fbid) => {
  return (dispatch, getState) => {
    const importedEvent = getState().entities.importedEvents[fbid];
    invariant(importedEvent, `Invalid provided facebook id ${fbid} to remove.`);

    const [ start, complete, fail ] = makeAsyncActions({
      types: [
        DELETE_IMPORTED_EVENT_START,
        DELETE_IMPORTED_EVENT_COMPLETE,
        DELETE_IMPORTED_EVENT_FAILURE
      ],
      data: { fbSourceId, fbid }
    });

    dispatch(start());
    dispatch(promiseForFreshFbEventById(fbid)).then(e => resetEventCategories(e))
      .then(fbEvent => {
        // Delete from imported events...
        dispatch(dashboardApi(`/events/fb/${fbid}`, deleteConfig()))
          .then(() => {
            // Merge fresh(?) facebook event in entities and remove the imported event
            dispatch(mergeEntities({
              fbEvents: { [fbid]: fbEvent }
            }));
            dispatch(removeEntities({
              importedEvents: fbid
            }));
            dispatch(complete());
          }, (r) => dispatch(fail(handleDashError(r))));
      }, (r) => dispatch(fail(handleFbError(r))));
  };
};

// Import event
export const importEvent = (fbSourceId, fbid) => {
  return (dispatch, getState) => {
    const fbEvent = getState().entities.fbEvents[fbid];
    invariant(fbEvent, `Invalid provided facebook id ${fbid} to import.`);

    const [ start, complete, fail ] = makeAsyncActions({
      types: [
        IMPORT_EVENT_START,
        IMPORT_EVENT_COMPLETE,
        IMPORT_EVENT_FAILURE
      ],
      data: { fbSourceId, fbid }
    });

    dispatch(start());
    dispatch(dashboardApi(`/events/fb`, jsonPostConfig(fbEvent)))
      .then(event => {
        dispatch(mergeEntities({
          ...normalizeImportEvent(event).entities
        }));
        dispatch(complete());
      }, (r) => dispatch(fail(handleDashError(r))));
  };
};

// Load events only if no receivedAt
export const loadImportEventsFirstTime = (fbSourceId) => {
  return (dispatch, getState) => {
    const list = (getState().importEvents[fbSourceId] || {}).list || {};
    if (!list.receivedAt && !list.loading) {
      dispatch(loadImportEvents(fbSourceId));
    }
  };
};

// Load events for importing later...
export const loadImportEvents = (fbSourceId) => {
  return (dispatch, getState) => {
    // Start the odissea
    const [ start, complete, fail ] = makeAsyncActions({
      types: [
        LOAD_IMPORT_EVENTS_START,
        LOAD_IMPORT_EVENTS_COMPLETE,
        LOAD_IMPORT_EVENTS_FAILURE
      ],
      data: { fbSourceId }
    });

    dispatch(start());
    dispatch(getFbIdsToImport(fbSourceId))
      .then(({ fbIdsToImport, paging }) => {

        // No new events posted by page... Import complete!
        if (fbIdsToImport.length === 0) {
          dispatch(complete({ paging, ids: fbIdsToImport, receivedAt: Date.now() }));
          return;
        }

        dispatch(importedEventsByFbIds(fbIdsToImport))
          .then(({ fbIds, entities }) => {
            const notImportedFbIds = difference(fbIdsToImport, fbIds);

            // All facebook ids are alredy imported... Import complete!
            if (notImportedFbIds.length === 0) {
              dispatch(mergeEntities({
                ...entities
              }));
              dispatch(complete({ paging, ids: fbIdsToImport, receivedAt: Date.now() }));
              return;
            }

            dispatch(fbEventsByIds(notImportedFbIds))
              .then(fbEvents => {
                  // Some ids could be invalid...
                  const importedFbIds = fbIdsToImport.filter(fbid =>
                    (entities.importedEvents && entities.importedEvents[fbid] ) ||
                    fbEvents[fbid]
                  );
                  // Finally can back to Itaca!
                  dispatch(mergeEntities({
                    fbEvents,
                    ...entities
                  }));
                  dispatch(complete({ paging, ids: importedFbIds, receivedAt: Date.now() }));
              }, (r) => dispatch(fail(handleFbError(r))));
          }, (r) => dispatch(fail(handleDashError(r))));
      }, (r) => dispatch(fail(handleFbError(r))));
  };
};

export const showAlredyImportedEvents = (fbSourceId) => ({
  fbSourceId,
  type: SHOW_ALREADY_IMPORTED_EVENTS
});

export const hideAlredyImportedEvents = (fbSourceId) => ({
  fbSourceId,
  type: HIDE_ALREADY_IMPORTED_EVENTS
});

export const showFullDescription = (fbSourceId, fbid) => ({
  fbSourceId,
  fbid,
  type: SHOW_IMPORT_EVENTS_FULL_DESCRIPTION
});

export const showLessDescription = (fbSourceId, fbid) => ({
  fbSourceId,
  fbid,
  type: SHOW_IMPORT_EVENTS_LESS_DESCRIPTION
});
