import { normalize } from 'normalizr';
import { graphApi } from './fb';
import { dashboardApi } from './laravel';
import { jsonPostConfig, deleteConfig, jsonPutConfig } from '../utils/fetch';
import { property, difference, uniq, omit, flow, pick, get, mapKeys, mapValues } from 'lodash';
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
  RESYNC_IMPORTED_EVENT_FAILURE
} from '../constants/ActionTypes';

// Grab facebook events ids from links in reponse

const fbEventRe = /^https:\/\/www\.facebook\.com\/events\/([0-9]+)/;

const grabFbEventsIdsFromLinks = (links) => links.reduce((r, v) => {
  const matches = v ? v.match(fbEventRe) : false;
  return matches ? [...r, matches[1]] : r;
}, []);

// Error handling...
// TODO: Imporve error handling
const makeHandleFbError = (type, data = {}) => (r) => (dispatch, getState) => dispatch({
  ...data,
  type,
  error: r.error ? `Mark Says ${r.error}` : r
});

const makeHandleDashError = (type, data = {}) => (r) => (dispatch, getState) => dispatch({
  ...data,
  type,
  error: r.error || r
});

const err = (error) => {
  throw new Error(error);
};

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
  ...pick(e, ['name', 'description', 'startTime', 'endTime'])
});
//const transformGraphFbEvent = (fbEvent) => flow(
  //e => mapKeys(e, (v, k) => k === 'id' ? 'fbid' : k),
  //e => pick(e, ['fbid', 'name', 'description', 'categories', 'start_time', 'type'])
//)(fbEvent);

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
  return fbEvent
     // Cached fb event without shit...
    ? Promise.resolve(omit(fbEvent, ['categories']))
    // Ask to Mark...
    : dispatch(fbEventById(fbid));
};

const importedEventsByFbIds = (fbids) => (dispatch, getState) =>
  dispatch(dashboardApi(`/events/fb?fbids=${fbids.join(',')}`))
    .then(normalizeImportEvents);

// TODO: In a very far future we can get events from differte sources...
const getFbIdsToImport = () => (dispatch, getState) => {
  // TODO: Maybe move in store!
  const fbPageId = 'cosafarealecco'; // Hardcoded with endless love...
  const importUrl = getState().importEvents.list.nextUrl || `/${fbPageId}/posts?fields=link&pretty=0`;

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

// ReSync imported event with facebook
export function reSyncImportedEvent(fbid) {
  return (dispatch, getState) => {
    const importedEvent = getState().entities.importedEvents[fbid];

    !importedEvent && err(`Invalid provided facebook id ${fbid} to resync.`);

    const handleFbError = makeHandleFbError(RESYNC_IMPORTED_EVENT_FAILURE, { fbid });
    const handleDashError = makeHandleDashError(RESYNC_IMPORTED_EVENT_FAILURE, { fbid });

    dispatch({ type: RESYNC_IMPORTED_EVENT_START, fbid });

    dispatch(fbEventById(fbid))
      .then(fbEvent => {
        dispatch(dashboardApi(`/events/fb/${fbid}`, jsonPutConfig(fbEvent)))
          .then(event => {
            dispatch(mergeEntities({
              ...normalizeImportEvent(event).entities,
              fbEvents: { [fbid]: fbEvent }
            }));
            dispatch({ type: RESYNC_IMPORTED_EVENT_COMPLETE, fbid });
          }, (r) => dispatch(handleDashError(r)));
      }, (r) => dispatch(handleFbError(r)));
  };
};

// Delete imported event
export function deleteImportedEvent(fbid) {
  return (dispatch, getState) => {
    const importedEvent = getState().entities.importedEvents[fbid];

    !importedEvent && err(`Invalid provided facebook id ${fbid} to remove.`);

    const handleFbError = makeHandleFbError(DELETE_IMPORTED_EVENT_FAILURE, { fbid });
    const handleDashError = makeHandleDashError(DELETE_IMPORTED_EVENT_FAILURE, { fbid });

    dispatch({ type: DELETE_IMPORTED_EVENT_START, fbid });

    dispatch(promiseForFreshFbEventById(fbid))
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
            dispatch({ type: DELETE_IMPORTED_EVENT_COMPLETE, fbid });
          }, (r) => dispatch(handleDashError(r)));
      }, (r) => dispatch(handleFbError(r)));
  };
};

// Import event
export function importEvent(fbid) {
  return (dispatch, getState) => {
    const fbEvent = getState().entities.fbEvents[fbid];

    !fbEvent && err(`Invalid provided facebook id ${fbid} to import.`);

    const handleDashError = makeHandleDashError(IMPORT_EVENT_FAILURE, { fbid });

    dispatch({ type: IMPORT_EVENT_START, fbid });

    dispatch(dashboardApi(`/events/fb`, jsonPostConfig(fbEvent)))
      .then(event => {
        dispatch(mergeEntities({
          ...normalizeImportEvent(event).entities
        }));
        dispatch({ type: IMPORT_EVENT_COMPLETE, fbid });
      }, (r) => dispatch(handleDashError(r)));
  };
}

// Load events for importing later...
export function loadImportEvents() {
  return (dispatch, getState) => {
    // Start the odissea

    const handleFbError = makeHandleFbError(LOAD_IMPORT_EVENTS_FAILURE);
    const handleDashError = makeHandleDashError(LOAD_IMPORT_EVENTS_FAILURE);

    dispatch({ type: LOAD_IMPORT_EVENTS_START });

    dispatch(getFbIdsToImport())
      .then(({ fbIdsToImport, paging }) => {

        // No new events posted by page... Import complete!
        if (fbIdsToImport.length === 0) {
          dispatch({
            paging,
            type: LOAD_IMPORT_EVENTS_COMPLETE,
            ids: fbIdsToImport
          });
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
              dispatch({
                paging,
                type: LOAD_IMPORT_EVENTS_COMPLETE,
                ids: fbIdsToImport
              });
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
                  dispatch({
                    paging,
                    type: LOAD_IMPORT_EVENTS_COMPLETE,
                    ids: importedFbIds
                  });
              }, (r) => dispatch(handleFbError(r)));
          }, (r) => dispatch(handleDashError(r)));
      }, (r) => dispatch(handleFbError(r)));
  };
}

export const showAlredyImportedEvents = () => ({
  type: SHOW_ALREADY_IMPORTED_EVENTS
});

export const hideAlredyImportedEvents = () => ({
  type: HIDE_ALREADY_IMPORTED_EVENTS
});

export const showFullDescription = (fbid) => ({
  fbid,
  type: SHOW_IMPORT_EVENTS_FULL_DESCRIPTION
});

export const showLessDescription = (fbid) => ({
  fbid,
  type: SHOW_IMPORT_EVENTS_LESS_DESCRIPTION
});
