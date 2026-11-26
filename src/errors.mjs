// 업무 오류를 HTTP 상태 코드와 함께 던지기 위한 작은 오류 클래스.
// 왜? "사용자 잘못(400/404/413/429)"과 "서버 내부 오류(500)"를 구분해,
// 내부 정보가 화면에 노출되지 않게 하려는 목적입니다.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
