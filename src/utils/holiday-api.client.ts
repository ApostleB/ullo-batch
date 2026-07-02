import axios from 'axios';
import { config } from '../config';

/** 공공데이터포털 특일정보 API 원본 아이템 */
export interface HolidayApiItem {
  dateKind: string; // 01~04
  dateName: string; // 공휴일명
  isHoliday: 'Y' | 'N';
  locdate: number; // YYYYMMDD
  seq: number;
}

interface HolidayApiResponse {
  response: {
    header: { resultCode: string; resultMsg: string };
    body: {
      items: { item?: HolidayApiItem | HolidayApiItem[] } | '' | null;
      numOfRows: number;
      pageNo: number;
      totalCount: number;
    };
  };
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * getHoliDeInfo — 지정 년/월의 공휴일 목록 조회.
 * 결과가 없는 달은 body.items가 '' 또는 null로 내려오므로 빈 배열로 정규화한다.
 * resultCode가 '00'이 아니면 throw → 상위 p-retry가 재시도.
 */
export async function fetchHolidays(solYear: number, solMonth: number): Promise<HolidayApiItem[]> {
  if (!config.openApi.serviceKey) {
    throw new Error('PUBLIC_DATA_API_KEY(공공데이터 서비스키)가 설정되지 않았습니다.');
  }

  const res = await axios.get<HolidayApiResponse>(
    `${config.openApi.baseUrl}/B090041/openapi/service/SpcdeInfoService/getHoliDeInfo`,
    {
      params: {
        serviceKey: config.openApi.serviceKey,
        pageNo: 1,
        numOfRows: 100,
        solYear,
        solMonth: String(solMonth).padStart(2, '0'),
        _type: 'json',
      },
      timeout: 10000,
    },
  );

  const { header, body } = res.data.response;
  if (header.resultCode !== '00') {
    throw new Error(`공휴일 API 오류: [${header.resultCode}] ${header.resultMsg}`);
  }

  const items = body.items ? toArray((body.items as { item?: HolidayApiItem | HolidayApiItem[] }).item) : [];
  return items;
}
