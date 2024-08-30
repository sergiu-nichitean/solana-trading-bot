interface ReportingData {
  buyTime: string;
  sellTriggerTime: string;
  sellTriggerAmount: string;
  burnedResult: string;
  renouncedResult: string;
  freezableResult: string;
  mutableResult: string;
  socialsResult: string;
  poolSizeResult: string;
  maxValue: string;
  maxValueTime: string;
}

export interface TokenData {
  [mint: string]: ReportingData;
}
