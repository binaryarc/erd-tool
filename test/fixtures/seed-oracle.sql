-- Oracle 어댑터 시험용 스키마 (STEP 9). 도커 Oracle 의 FREEPDB1, 계정(스키마) ERD. 시험 시작에 지우고 다시 넣는다.
-- 단일과 복합 PK, 복합 FK, ON DELETE CASCADE, UNIQUE, 일반과 UNIQUE 인덱스, IDENTITY, 기본값, 가상 컬럼, 코멘트, CHECK, 시퀀스, 뷰(경고 확인용)
DROP VIEW IF EXISTS erd_v_order;
DROP TABLE IF EXISTS erd_order_item PURGE;
DROP TABLE IF EXISTS erd_order PURGE;
DROP TABLE IF EXISTS erd_product PURGE;
DROP TABLE IF EXISTS erd_customer PURGE;
DROP TABLE IF EXISTS erd_code PURGE;
DROP SEQUENCE IF EXISTS erd_seq;
CREATE TABLE erd_customer (
  cust_id NUMBER(10) GENERATED ALWAYS AS IDENTITY (START WITH 1000 INCREMENT BY 10) NOT NULL,
  cust_cd VARCHAR2(20) NOT NULL,
  cust_nm VARCHAR2(100 CHAR) NOT NULL,
  grade CHAR(1) DEFAULT 'A' NOT NULL,
  reg_dt TIMESTAMP(3) DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_erd_customer PRIMARY KEY (cust_id),
  CONSTRAINT uq_erd_customer_cd UNIQUE (cust_cd),
  CONSTRAINT ck_erd_customer_grade CHECK (grade IN ('A', 'B', 'C'))
);
CREATE TABLE erd_product (
  prod_cd VARCHAR2(20) NOT NULL,
  prod_nm VARCHAR2(200) NOT NULL,
  price NUMBER(12,2),
  memo CLOB,
  CONSTRAINT pk_erd_product PRIMARY KEY (prod_cd)
);
CREATE TABLE erd_order (
  order_no VARCHAR2(20) NOT NULL,
  order_seq NUMBER(5) NOT NULL,
  cust_id NUMBER(10) NOT NULL,
  order_dt DATE NOT NULL,
  amount NUMBER(12,2) DEFAULT 0 NOT NULL,
  CONSTRAINT pk_erd_order PRIMARY KEY (order_no, order_seq),
  CONSTRAINT fk_erd_order_cust FOREIGN KEY (cust_id) REFERENCES erd_customer (cust_id) ON DELETE CASCADE
);
CREATE TABLE erd_order_item (
  order_no VARCHAR2(20) NOT NULL,
  order_seq NUMBER(5) NOT NULL,
  item_no NUMBER(5) NOT NULL,
  prod_cd VARCHAR2(20) NOT NULL,
  qty INTEGER NOT NULL,
  qty2 NUMBER GENERATED ALWAYS AS (qty * 2) VIRTUAL,
  CONSTRAINT pk_erd_order_item PRIMARY KEY (order_no, order_seq, item_no),
  CONSTRAINT fk_erd_item_order FOREIGN KEY (order_no, order_seq) REFERENCES erd_order (order_no, order_seq) ON DELETE CASCADE,
  CONSTRAINT fk_erd_item_prod FOREIGN KEY (prod_cd) REFERENCES erd_product (prod_cd) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE erd_code (
  grp_cd VARCHAR2(10) NOT NULL,
  cd VARCHAR2(10) NOT NULL,
  cd_nm VARCHAR2(50),
  CONSTRAINT pk_erd_code PRIMARY KEY (grp_cd, cd)
);
CREATE INDEX ix_erd_order_cust ON erd_order (cust_id, order_dt);
CREATE UNIQUE INDEX ux_erd_product_nm ON erd_product (prod_nm);
CREATE SEQUENCE erd_seq START WITH 100 INCREMENT BY 10;
COMMENT ON TABLE erd_customer IS '거래처';
COMMENT ON COLUMN erd_customer.cust_cd IS '거래처 코드';
COMMENT ON TABLE erd_order IS '주문';
CREATE VIEW erd_v_order AS SELECT o.order_no, c.cust_nm FROM erd_order o JOIN erd_customer c ON c.cust_id = o.cust_id;
