// Network Rail TRUST train movement feed (TRAIN_MVT_ALL_TOC).
// Every value in a message body arrives as a string (or null).
// Field reference: https://wiki.openraildata.com/index.php/Train_Movements

export const MSG_ACTIVATION = '0001';
export const MSG_CANCELLATION = '0002';
export const MSG_MOVEMENT = '0003';
export const MSG_REINSTATEMENT = '0005';
export const MSG_CHANGE_OF_ORIGIN = '0006';
export const MSG_CHANGE_OF_IDENTITY = '0007';
export const MSG_CHANGE_OF_LOCATION = '0008';

export interface TrustHeader {
  msg_type: string;
  msg_queue_timestamp?: string;
  source_system_id?: string;
  original_data_source?: string;
}

export type TrustBody = Record<string, string | null | undefined>;

export interface TrustMessage {
  header: TrustHeader;
  body: TrustBody;
}

/** The subset of a 0003 movement body the engine reads. */
export interface MovementBody {
  train_id: string;
  event_type: string; // ARRIVAL | DEPARTURE
  planned_event_type?: string; // ARRIVAL | DEPARTURE | DESTINATION
  actual_timestamp: string; // ms since epoch
  planned_timestamp?: string | null; // ms since epoch, as timetabled
  loc_stanox: string;
  next_report_stanox?: string | null;
  next_report_run_time?: string | null; // whole minutes
  timetable_variation?: string; // whole minutes, unsigned
  variation_status?: string; // ON TIME | EARLY | LATE | OFF ROUTE
  toc_id?: string;
  train_terminated?: string; // "true" | "false"
  platform?: string | null;
}
