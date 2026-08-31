-- 1. 创建 dbms_scheduler 模式
CREATE SCHEMA IF NOT EXISTS dbms_scheduler;

-- 2. 创建 create_job（带 SECURITY DEFINER 与真实用户绑定）
CREATE OR REPLACE PROCEDURE dbms_scheduler.create_job(
    p_job_name        IN text,
    p_job_type        IN text,
    p_job_action      IN text,
    p_start_date      IN timestamp DEFAULT sysdate,
    p_repeat_interval IN text DEFAULT NULL,
    p_enabled         IN boolean DEFAULT TRUE
)
SECURITY DEFINER
AS
DECLARE
    v_job_id int;
BEGIN
    -- 提交底层任务
    SELECT pkg_service.job_submit(NULL, p_job_action, p_start_date, COALESCE(p_repeat_interval, 'null'))
    INTO v_job_id;

    -- 写入语义化名称、enable 状态以及调用者的真实身份
    UPDATE pg_catalog.pg_job
    SET job_name  = p_job_name,
        enable    = p_enabled,
        log_user  = SESSION_USER,
        priv_user = SESSION_USER
    WHERE job_id = v_job_id;
END;
/

-- 3. 创建 disable（带 SECURITY DEFINER）
CREATE OR REPLACE PROCEDURE dbms_scheduler.disable(p_job_name IN text)
SECURITY DEFINER
AS
BEGIN
    UPDATE pg_catalog.pg_job
    SET enable = false, job_status = 'd'
    WHERE job_name = p_job_name
      AND (priv_user = SESSION_USER OR (SELECT rolsuper FROM pg_roles WHERE rolname = SESSION_USER));

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job "%" does not exist or permission denied', p_job_name;
    END IF;
END;
/

-- 4. 创建 enable（带 SECURITY DEFINER）
CREATE OR REPLACE PROCEDURE dbms_scheduler.enable(p_job_name IN text)
SECURITY DEFINER
AS
BEGIN
    UPDATE pg_catalog.pg_job
    SET enable = true, job_status = 's', next_run_date = sysdate
    WHERE job_name = p_job_name
      AND (priv_user = SESSION_USER OR (SELECT rolsuper FROM pg_roles WHERE rolname = SESSION_USER));

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job "%" does not exist or permission denied', p_job_name;
    END IF;
END;
/

-- 5. 创建 drop_job（带 SECURITY DEFINER）
CREATE OR REPLACE PROCEDURE dbms_scheduler.drop_job(p_job_name IN text)
SECURITY DEFINER
AS
DECLARE
    v_job_id bigint;
BEGIN
    SELECT job_id INTO v_job_id
    FROM pg_catalog.pg_job
    WHERE job_name = p_job_name
      AND (priv_user = SESSION_USER OR (SELECT rolsuper FROM pg_roles WHERE rolname = SESSION_USER));

    IF v_job_id IS NOT NULL THEN
        DELETE FROM pg_catalog.pg_job_proc WHERE job_id = v_job_id;
        DELETE FROM pg_catalog.pg_job WHERE job_id = v_job_id;
    ELSE
        RAISE EXCEPTION 'Job "%" does not exist or permission denied', p_job_name;
    END IF;
END;
/

-- 5. 更新 update_job（带 SECURITY DEFINER）
CREATE OR REPLACE PROCEDURE dbms_scheduler.update_job(
    p_job_name_or_id  IN text,
    p_job_action      IN text,
    p_repeat_interval IN text,
    p_enabled         IN boolean
)
 SECURITY DEFINER
AS DECLARE
    v_job_id int8;
BEGIN
    SELECT job_id INTO v_job_id
    FROM pg_catalog.pg_job
    WHERE (job_name = p_job_name_or_id OR job_id::text = p_job_name_or_id)
      AND dbname = current_database()
    LIMIT 1;

    IF v_job_id IS NOT NULL THEN
        IF p_job_action IS NOT NULL THEN
            UPDATE pg_catalog.pg_job_proc
            SET what = p_job_action
            WHERE job_id = v_job_id;
        END IF;

        UPDATE pg_catalog.pg_job
        SET interval   = COALESCE(p_repeat_interval, interval),
            enable     = COALESCE(p_enabled, enable),
            job_status = CASE WHEN p_enabled = false THEN 'd' ELSE 's' END
        WHERE job_id = v_job_id;
    END IF;
END;
/

-- 6. 将模式使用权和存储过程执行权赋予所有用户
GRANT USAGE ON SCHEMA dbms_scheduler TO PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA dbms_scheduler TO PUBLIC;
